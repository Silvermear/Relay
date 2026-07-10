const supabase = require('./supabase.js');

const tabs = document.querySelectorAll('.tab');
const viewPanels = document.querySelectorAll('.view-panel');
const searchBox = document.getElementById('search-box');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const targetView = tab.getAttribute('data-view');

    viewPanels.forEach(panel => panel.classList.remove('active'));
    document.getElementById('view-' + targetView).classList.add('active');

    if (targetView === 'add') {
      searchBox.classList.add('hidden');
    } else {
      searchBox.classList.remove('hidden');
    }
  });
});

// Giriş yapan kullanıcının bilgisini yükle
let currentUser = null;
let activeChatFriend = null;
let activeChatSubscription = null;
let activeCall = null;
let callSubscription = null;
let callTimerInterval = null;
let callSeconds = 0;
let micMuted = false;
let selectedMicId = null;
let selectedSpeakerId = null;

// ===== WEBRTC (gerçek ses bağlantısı) =====

let peerConnection = null;
let localStream = null;
let signalChannel = null;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function getSignalChannelName(callerId, receiverId) {
  return 'webrtc-' + [callerId, receiverId].sort().join('-');
}

async function startWebRTC(isCaller) {
  await stopWebRTC();

  const constraints = {
    audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    console.warn('Mikrofona erişilemedi:', error);
    return;
  }

  applyMicMuteToStream();

  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio.srcObject !== event.streams[0]) {
      remoteAudio.srcObject = event.streams[0];
      applySpeakerToRemoteAudio();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && signalChannel) {
      signalChannel.send({
        type: 'broadcast',
        event: 'webrtc-ice',
        payload: { candidate: event.candidate, from: currentUser.id }
      });
    }
  };

  const channelName = getSignalChannelName(activeCall.caller_id, activeCall.receiver_id);
  signalChannel = supabase.channel(channelName);

  signalChannel
    .on('broadcast', { event: 'webrtc-offer' }, async (payload) => {
      if (payload.payload.from === currentUser.id || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.payload.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      signalChannel.send({
        type: 'broadcast',
        event: 'webrtc-answer',
        payload: { answer, from: currentUser.id }
      });
    })
    .on('broadcast', { event: 'webrtc-answer' }, async (payload) => {
      if (payload.payload.from === currentUser.id || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.payload.answer));
    })
    .on('broadcast', { event: 'webrtc-ice' }, async (payload) => {
      if (payload.payload.from === currentUser.id || !peerConnection) return;
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(payload.payload.candidate));
      } catch (error) {
        console.warn('ICE candidate eklenemedi:', error);
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && isCaller && peerConnection) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalChannel.send({
          type: 'broadcast',
          event: 'webrtc-offer',
          payload: { offer, from: currentUser.id }
        });
      }
    });
}

async function stopWebRTC() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (signalChannel) {
    supabase.removeChannel(signalChannel);
    signalChannel = null;
  }
  const remoteAudio = document.getElementById('remote-audio');
  remoteAudio.srcObject = null;
}

function applyMicMuteToStream() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !micMuted;
  });
}

function applySpeakerToRemoteAudio() {
  const remoteAudio = document.getElementById('remote-audio');
  if (selectedSpeakerId && remoteAudio.setSinkId) {
    remoteAudio.setSinkId(selectedSpeakerId).catch(err => console.warn('Hoparlör ayarlanamadı:', err));
  }
}

async function switchMicrophone(deviceId) {
  selectedMicId = deviceId;
  if (!peerConnection || !localStream) return;

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const newTrack = newStream.getAudioTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      await sender.replaceTrack(newTrack);
    }
    localStream.getAudioTracks().forEach(t => t.stop());
    localStream = newStream;
    applyMicMuteToStream();
  } catch (error) {
    console.warn('Mikrofon değiştirilemedi:', error);
  }
}

// ===== RINGTONE (kendi ses dosyalarımız) =====

function startOutgoingRingtone() {
  stopAllRingtones();
  const audio = document.getElementById('ringtone-outgoing');
  audio.currentTime = 0;
  audio.play().catch(err => console.warn('Ringtone çalınamadı:', err));
}

function startIncomingRingtone() {
  stopAllRingtones();
  const audio = document.getElementById('ringtone-incoming');
  audio.currentTime = 0;
  audio.play().catch(err => console.warn('Ringtone çalınamadı:', err));
}

function stopAllRingtones() {
  const outgoing = document.getElementById('ringtone-outgoing');
  const incoming = document.getElementById('ringtone-incoming');
  outgoing.pause();
  outgoing.currentTime = 0;
  incoming.pause();
  incoming.currentTime = 0;
}

function setCallConnecting(isOutgoing) {
  const callArea = document.getElementById('call-area');
  const statusEl = document.getElementById('call-status');

  callArea.classList.remove('connected');
  statusEl.classList.remove('connected');
  statusEl.textContent = 'Bağlanıyor...';
  document.getElementById('call-timer').classList.add('hidden');
  document.getElementById('call-remote-mute').classList.add('hidden');

  if (isOutgoing) {
    startOutgoingRingtone();
  }
}

function setCallConnected() {
  const callArea = document.getElementById('call-area');
  const statusEl = document.getElementById('call-status');

  if (callArea.classList.contains('connected')) return;

  callArea.classList.add('connected');
  statusEl.classList.add('connected');
  statusEl.textContent = 'Bağlandı';
  stopAllRingtones();
  startCallTimer();

  const isCaller = activeCall && activeCall.caller_id === currentUser.id;
  startWebRTC(isCaller);
}

function broadcastMuteState() {
  if (!callSubscription || !currentUser || !activeCall) return;

  callSubscription.send({
    type: 'broadcast',
    event: 'mute',
    payload: {
      userId: currentUser.id,
      muted: micMuted
    }
  });
}

function updateRemoteMuteIndicator(isMuted) {
  document.getElementById('call-remote-mute').classList.toggle('hidden', !isMuted);
}

// ===== CİHAZ TARAMA (Mikrofon / Kulaklık) =====

async function getAudioDevices() {
  try {
    // İzin almak için önce mikrofona erişim isteriz (etiketlerin görünmesi için gerekli)
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(track => track.stop());
    }).catch(() => {});

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const speakers = devices.filter(d => d.kind === 'audiooutput');
    return { mics, speakers };
  } catch (error) {
    console.warn('Cihazlar taranamadı:', error);
    return { mics: [], speakers: [] };
  }
}

function closeAllDeviceMenus() {
  document.getElementById('mic-device-menu').classList.add('hidden');
  document.getElementById('speaker-device-menu').classList.add('hidden');
  document.getElementById('call-mic-btn').classList.remove('active-menu');
  document.getElementById('call-speaker-btn').classList.remove('active-menu');
}

function renderDeviceMenu(menuEl, devices, selectedId, onSelect, emptyLabel) {
  menuEl.innerHTML = '';

  if (devices.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'device-menu-empty';
    emptyDiv.textContent = emptyLabel;
    menuEl.appendChild(emptyDiv);
    return;
  }

  devices.forEach((device, index) => {
    const item = document.createElement('div');
    item.className = 'device-menu-item';
    if (device.deviceId === selectedId || (!selectedId && index === 0)) {
      item.classList.add('selected');
    }
    item.textContent = device.label || ('Cihaz ' + (index + 1));
    item.addEventListener('click', () => {
      onSelect(device.deviceId);
      menuEl.classList.add('hidden');
      document.getElementById('call-mic-btn').classList.remove('active-menu');
      document.getElementById('call-speaker-btn').classList.remove('active-menu');
    });
    menuEl.appendChild(item);
  });
}

async function setupDeviceMenus() {
  const { mics, speakers } = await getAudioDevices();

  const micMenu = document.getElementById('mic-device-menu');
  const speakerMenu = document.getElementById('speaker-device-menu');

  renderDeviceMenu(micMenu, mics, selectedMicId, (id) => {
    switchMicrophone(id);
  }, 'Mikrofon bulunamadı');

  renderDeviceMenu(speakerMenu, speakers, selectedSpeakerId, (id) => {
    selectedSpeakerId = id;
    applySpeakerToRemoteAudio();
  }, 'Kulaklık/Hoparlör bulunamadı');
}

document.getElementById('call-mic-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = document.getElementById('mic-device-menu');
  const isHidden = menu.classList.contains('hidden');
  closeAllDeviceMenus();

  if (isHidden) {
    await setupDeviceMenus();
    menu.classList.remove('hidden');
    document.getElementById('call-mic-btn').classList.add('active-menu');
  }
});

document.getElementById('call-speaker-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = document.getElementById('speaker-device-menu');
  const isHidden = menu.classList.contains('hidden');
  closeAllDeviceMenus();

  if (isHidden) {
    await setupDeviceMenus();
    menu.classList.remove('hidden');
    document.getElementById('call-speaker-btn').classList.add('active-menu');
  }
});

document.addEventListener('click', () => {
  closeAllDeviceMenus();
});

// Susturma butonu
document.getElementById('call-mute-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  micMuted = !micMuted;
  document.getElementById('call-mute-btn').classList.toggle('muted', micMuted);
  applyMicMuteToStream();
  broadcastMuteState();
});

async function loadUserProfile() {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  currentUser = user;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .single();

  if (profile) {
    document.getElementById('user-name').textContent = profile.username;
    document.getElementById('user-avatar').textContent = profile.username.charAt(0).toUpperCase();
  }

  loadFriendshipsData();
  subscribeToIncomingCalls();
}

loadUserProfile();

// Arkadaş Ekle işlemi
const addFriendBtn = document.getElementById('add-friend-btn');

addFriendBtn.addEventListener('click', async () => {
  const usernameInput = document.getElementById('add-friend-input');
  const messageDiv = document.getElementById('add-friend-message');
  const targetUsername = usernameInput.value.trim();

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!targetUsername) {
    messageDiv.textContent = 'Lütfen bir kullanıcı adı gir.';
    messageDiv.classList.add('error');
    return;
  }

  if (!currentUser) {
    messageDiv.textContent = 'Kullanıcı bilgisi yüklenemedi, sayfayı yenile.';
    messageDiv.classList.add('error');
    return;
  }

  const { data: targetProfile, error: searchError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', targetUsername)
    .single();

  if (searchError || !targetProfile) {
    messageDiv.textContent = 'Bu kullanıcı adına sahip biri bulunamadı.';
    messageDiv.classList.add('error');
    return;
  }

  if (targetProfile.id === currentUser.id) {
    messageDiv.textContent = 'Kendine arkadaşlık isteği gönderemezsin.';
    messageDiv.classList.add('error');
    return;
  }

  const { error: insertError } = await supabase
    .from('friendships')
    .insert({ user_id: currentUser.id, friend_id: targetProfile.id });

  if (insertError) {
    if (insertError.code === '23505') {
      messageDiv.textContent = 'Bu kullanıcıya zaten bir istek gönderdin.';
    } else {
      messageDiv.textContent = 'Hata: ' + insertError.message;
    }
    messageDiv.classList.add('error');
    return;
  }

  messageDiv.textContent = targetProfile.username + ' kullanıcısına arkadaşlık isteği gönderildi!';
  messageDiv.classList.add('success');
  usernameInput.value = '';

  loadFriendshipsData();
});

// Arkadaşlık verilerini yükle
async function loadFriendshipsData() {
  if (!currentUser) return;

  const { data: pendingRequests } = await supabase
    .from('friendships')
    .select('id, user_id, profiles:user_id (username)')
    .eq('friend_id', currentUser.id)
    .eq('status', 'pending');

  const { data: acceptedAsSender } = await supabase
    .from('friendships')
    .select('id, friend_id, profiles:friend_id (username)')
    .eq('user_id', currentUser.id)
    .eq('status', 'accepted');

  const { data: acceptedAsReceiver } = await supabase
    .from('friendships')
    .select('id, user_id, profiles:user_id (username)')
    .eq('friend_id', currentUser.id)
    .eq('status', 'accepted');

  renderPendingRequests(pendingRequests || []);

  const normalizedFriends = [
    ...(acceptedAsSender || []).map(f => ({ id: f.friend_id, username: f.profiles.username })),
    ...(acceptedAsReceiver || []).map(f => ({ id: f.user_id, username: f.profiles.username }))
  ];

  renderFriendsList(normalizedFriends);
  renderOnlineFriendsList(normalizedFriends);
  renderDmList(normalizedFriends);
}

// Bekleyen istekleri ekrana bas
function renderPendingRequests(requests) {
  const onlinePanel = document.getElementById('view-online');
  let pendingContainer = document.getElementById('pending-requests-container');

  if (pendingContainer) {
    pendingContainer.remove();
  }

  if (requests.length === 0) return;

  pendingContainer = document.createElement('div');
  pendingContainer.id = 'pending-requests-container';

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'Bekleyen İstekler — ' + requests.length;
  pendingContainer.appendChild(label);

  requests.forEach(req => {
    const item = document.createElement('div');
    item.className = 'friend';

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar';
    avatar.textContent = req.profiles.username.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'friend-info';
    info.innerHTML = '<div class="friend-name">' + req.profiles.username + '</div><div class="friend-status">Arkadaşlık isteği gönderdi</div>';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.marginLeft = 'auto';

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Kabul Et';
    acceptBtn.className = 'add-friend-btn';
    acceptBtn.style.width = 'auto';
    acceptBtn.style.padding = '6px 10px';
    acceptBtn.style.fontSize = '12px';
    acceptBtn.addEventListener('click', () => respondToRequest(req.id, 'accepted'));

    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = 'Reddet';
    rejectBtn.className = 'add-friend-btn';
    rejectBtn.style.width = 'auto';
    rejectBtn.style.padding = '6px 10px';
    rejectBtn.style.fontSize = '12px';
    rejectBtn.style.backgroundColor = '#3a3a3d';
    rejectBtn.style.color = '#e8e6e3';
    rejectBtn.addEventListener('click', () => respondToRequest(req.id, 'rejected'));

    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);

    item.appendChild(avatar);
    item.appendChild(info);
    item.appendChild(actions);

    pendingContainer.appendChild(item);
  });

  onlinePanel.insertBefore(pendingContainer, onlinePanel.firstChild);
}

// İsteğe yanıt ver
async function respondToRequest(requestId, newStatus) {
  const { error } = await supabase
    .from('friendships')
    .update({ status: newStatus })
    .eq('id', requestId);

  if (!error) {
    loadFriendshipsData();
  }
}

// Arkadaş kartı oluştur
function createFriendCard(friend, statusText) {
  const item = document.createElement('div');
  item.className = 'friend';

  const avatar = document.createElement('div');
  avatar.className = 'friend-avatar';
  avatar.textContent = friend.username.charAt(0).toUpperCase();

  const info = document.createElement('div');
  info.className = 'friend-info';
  info.innerHTML = '<div class="friend-name">' + friend.username + '</div><div class="friend-status">' + statusText + '</div>';

  item.appendChild(avatar);
  item.appendChild(info);

  item.addEventListener('click', () => {
    openChat(friend.id, friend.username);
  });

  return item;
}

// Çevrim içi arkadaşları göster
function renderOnlineFriendsList(friends) {
  const onlinePanel = document.getElementById('view-online');
  const label = onlinePanel.querySelector('.section-label');
  const emptyMsg = onlinePanel.querySelector('.empty-list');

  label.textContent = 'Çevrim içi — ' + friends.length;

  const existingCards = onlinePanel.querySelectorAll('.friend');
  existingCards.forEach(card => card.remove());

  if (friends.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';

  friends.forEach(friend => {
    const item = createFriendCard(friend, 'Çevrimiçi');
    onlinePanel.appendChild(item);
  });
}

// Tüm arkadaşları göster
function renderFriendsList(friends) {
  const allPanel = document.getElementById('view-all');
  const label = allPanel.querySelector('.section-label');
  const emptyMsg = allPanel.querySelector('.empty-list');

  label.textContent = 'Tüm Arkadaşlar — ' + friends.length;

  const existingCards = allPanel.querySelectorAll('.friend');
  existingCards.forEach(card => card.remove());

  if (friends.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';

  friends.forEach(friend => {
    const item = createFriendCard(friend, 'Arkadaş');
    allPanel.appendChild(item);
  });
}

// DM listesi güncelle
function renderDmList(friends) {
  const dmList = document.getElementById('dm-list');
  const dmEmpty = document.getElementById('dm-empty');

  dmList.innerHTML = '';

  if (friends.length === 0) {
    dmEmpty.style.display = 'block';
    return;
  }

  dmEmpty.style.display = 'none';

  friends.forEach(friend => {
    const item = document.createElement('div');
    item.className = 'dm-item';

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar';
    avatar.textContent = friend.username.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'friend-info';
    info.innerHTML = '<div class="friend-name">' + friend.username + '</div>';

    item.appendChild(avatar);
    item.appendChild(info);

    item.addEventListener('click', () => {
      openChat(friend.id, friend.username);
    });

    dmList.appendChild(item);
  });
}

// Sohbet ekranını aç
async function openChat(friendId, friendUsername) {
  activeChatFriend = { id: friendId, username: friendUsername };

  document.getElementById('friends-area').classList.add('hidden');
  document.getElementById('chat-area').classList.remove('hidden');

  document.getElementById('chat-username').textContent = friendUsername;
  document.getElementById('chat-avatar').textContent = friendUsername.charAt(0).toUpperCase();

  await loadMessages();
  subscribeToMessages();
}

// Arkadaşlara geri dön
document.getElementById('back-to-friends').addEventListener('click', () => {
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('friends-area').classList.remove('hidden');

  if (activeChatSubscription) {
    supabase.removeChannel(activeChatSubscription);
    activeChatSubscription = null;
  }
  activeChatFriend = null;
});

// ===== ARAMA MANTIGI =====

// Telefon ikonuna tıkla → Arama başlat
document.getElementById('chat-call-btn').addEventListener('click', async () => {
  if (!activeChatFriend || !currentUser) return;

  // Arama isteği oluştur
  const { error } = await supabase
    .from('calls')
    .insert({
      caller_id: currentUser.id,
      receiver_id: activeChatFriend.id,
      status: 'pending'
    });

  if (!error) {
    activeCall = {
      caller_id: currentUser.id,
      receiver_id: activeChatFriend.id,
      status: 'pending'
    };
    // Arama başladığını göster
    showActiveCallScreen();
    setCallConnecting(true);
  }
});

// Gelen aramaları dinle
function subscribeToIncomingCalls() {
  if (!currentUser) return;

  callSubscription = supabase
    .channel('calls-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls' }, (payload) => {
      const call = payload.new;
      
      // Eğer bana gelen arama ise
      if (call.receiver_id === currentUser.id && call.status === 'pending') {
        showIncomingCallModal(call);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, (payload) => {
      const call = payload.new;

      // Eğer arama kabul edilirse
      if (activeCall && call.caller_id === activeCall.caller_id && call.receiver_id === activeCall.receiver_id && call.status === 'active') {
        activeCall = call;
        setCallConnected();
      }

      // Eğer arama reddedilirse veya biterse
      if (activeCall && call.caller_id === activeCall.caller_id && call.receiver_id === activeCall.receiver_id && (call.status === 'declined' || call.status === 'ended')) {
        endCall();
      }
    })
    .on('broadcast', { event: 'mute' }, (payload) => {
      if (!activeCall || !currentUser) return;
      if (payload.payload.userId === currentUser.id) return;
      updateRemoteMuteIndicator(payload.payload.muted);
    })
    .subscribe();
}

// Gelen arama modal'ını göster
async function showIncomingCallModal(call) {
  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', call.caller_id)
    .single();

  if (callerProfile) {
    document.getElementById('call-modal-name').textContent = callerProfile.username;
    document.getElementById('call-modal-avatar').textContent = callerProfile.username.charAt(0).toUpperCase();
  }

  activeCall = call;
  document.getElementById('call-modal').classList.remove('hidden');
  startIncomingRingtone();

  // Kabul Et butonu
  document.getElementById('call-accept-btn').onclick = async () => {
    await supabase
      .from('calls')
      .update({ status: 'active' })
      .eq('caller_id', call.caller_id)
      .eq('receiver_id', call.receiver_id);

    document.getElementById('call-modal').classList.add('hidden');
    stopAllRingtones();
    showActiveCallScreen({ username: callerProfile ? callerProfile.username : 'Kullanıcı' });
    setCallConnected();
  };

  // Reddet butonu
  document.getElementById('call-decline-btn').onclick = async () => {
    await supabase
      .from('calls')
      .update({ status: 'declined' })
      .eq('caller_id', call.caller_id)
      .eq('receiver_id', call.receiver_id);

    document.getElementById('call-modal').classList.add('hidden');
    stopAllRingtones();
    activeCall = null;
  };
}

// Aktif arama ekranını göster
function showActiveCallScreen(displayUser) {
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('call-area').classList.remove('hidden');

  micMuted = false;
  document.getElementById('call-mute-btn').classList.remove('muted');
  document.getElementById('call-remote-mute').classList.add('hidden');
  closeAllDeviceMenus();

  const username = displayUser?.username || activeChatFriend?.username || 'Kullanıcı';
  document.getElementById('call-name').textContent = username;
  document.getElementById('call-avatar-large').textContent = username.charAt(0).toUpperCase();

  // Arama sona erdir butonu
  document.getElementById('call-end-btn').onclick = endCall;
}

// Arama süresi sayacını başlat
function startCallTimer() {
  callSeconds = 0;
  const timerEl = document.getElementById('call-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = '00:00';

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
  }

  callTimerInterval = setInterval(() => {
    callSeconds++;
    const minutes = Math.floor(callSeconds / 60).toString().padStart(2, '0');
    const seconds = (callSeconds % 60).toString().padStart(2, '0');
    timerEl.textContent = minutes + ':' + seconds;
  }, 1000);
}

// Arama süresi sayacını durdur
function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callSeconds = 0;
  document.getElementById('call-timer').classList.add('hidden');
}

// Aramayı sonlandır
async function endCall() {
  stopAllRingtones();
  await stopWebRTC();

  if (activeCall) {
    await supabase
      .from('calls')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('caller_id', activeCall.caller_id)
      .eq('receiver_id', activeCall.receiver_id);
  }

  stopCallTimer();
  closeAllDeviceMenus();
  document.getElementById('call-area').classList.remove('connected');
  document.getElementById('call-status').classList.remove('connected');
  document.getElementById('call-area').classList.add('hidden');
  document.getElementById('chat-area').classList.remove('hidden');
  document.getElementById('call-remote-mute').classList.add('hidden');
  activeCall = null;
}

// ===== MESAJ MANTIGI =====

// Mesajları yükle
async function loadMessages() {
  if (!currentUser || !activeChatFriend) return;

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .or(
      'and(sender_id.eq.' + currentUser.id + ',receiver_id.eq.' + activeChatFriend.id + '),' +
      'and(sender_id.eq.' + activeChatFriend.id + ',receiver_id.eq.' + currentUser.id + ')'
    )
    .order('created_at', { ascending: true });

  const chatMessages = document.getElementById('chat-messages');
  chatMessages.innerHTML = '';

  if (messages) {
    messages.forEach(msg => {
      appendMessageToChat(msg);
    });
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Tek bir mesajı ekrana ekle
function appendMessageToChat(msg) {
  const chatMessages = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = 'chat-message ' + (msg.sender_id === currentUser.id ? 'sent' : 'received');
  bubble.textContent = msg.content;
  chatMessages.appendChild(bubble);
}

// Gerçek zamanlı mesaj dinleme
function subscribeToMessages() {
  if (activeChatSubscription) {
    supabase.removeChannel(activeChatSubscription);
  }

  activeChatSubscription = supabase
    .channel('messages-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      if (!activeChatFriend) return;

      const isRelevant =
        (msg.sender_id === currentUser.id && msg.receiver_id === activeChatFriend.id) ||
        (msg.sender_id === activeChatFriend.id && msg.receiver_id === currentUser.id);

      if (isRelevant) {
        appendMessageToChat(msg);
        const chatMessages = document.getElementById('chat-messages');
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    })
    .subscribe();
}

// Mesaj gönder
document.getElementById('chat-send-btn').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
});

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();

  if (!content || !activeChatFriend || !currentUser) return;

  const { error } = await supabase
    .from('messages')
    .insert({
      sender_id: currentUser.id,
      receiver_id: activeChatFriend.id,
      content: content
    });

  if (!error) {
    input.value = '';
  }
}