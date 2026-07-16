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

// Sol alttaki genel (global) mikrofon/kulaklık varsayılan durumu
let globalMicOff = false;
let globalSpeakerOff = false;

// Grup ile ilgili durumlar
let userFriendsList = [];
let userGroups = [];
let activeGroup = null;
let groupChatSubscription = null;
let groupInviteSubscription = null;
let groupCallSubscription = null;
let activeGroupCallId = null;
let groupCallMuted = false;

// ===== SOL ALTTAKİ GENEL MİKROFON / KULAKLIK KONTROLÜ =====

const sidebarMicBtn = document.getElementById('mic-btn');
const sidebarHeadphoneBtn = document.getElementById('headphone-btn');
const sidebarSettingsBtn = document.getElementById('settings-btn');

sidebarMicBtn.addEventListener('click', () => {
  globalMicOff = !globalMicOff;
  sidebarMicBtn.classList.toggle('muted', globalMicOff);
  sidebarMicBtn.textContent = globalMicOff ? '🔇' : '🎤';

  if (activeCall) {
    micMuted = globalMicOff;
    document.getElementById('call-mute-btn').classList.toggle('muted', micMuted);
    applyMicMuteToStream();
    broadcastMuteState();
  }
});

sidebarHeadphoneBtn.addEventListener('click', () => {
  globalSpeakerOff = !globalSpeakerOff;
  sidebarHeadphoneBtn.classList.toggle('muted', globalSpeakerOff);
  sidebarHeadphoneBtn.textContent = globalSpeakerOff ? '🔇' : '🎧';

  const remoteAudio = document.getElementById('remote-audio');
  remoteAudio.muted = globalSpeakerOff;
});

sidebarSettingsBtn.addEventListener('click', () => {
  alert('⚙️ Ayarlar yakında eklenecek!');
});

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

async function getLocalStreamWithDevice(deviceId) {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  try {
    const constraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    applyMicMuteToStream(stream);
    return stream;
  } catch (error) {
    console.error('Mikrofona erişilemedi:', error);
    return null;
  }
}

async function startWebRTC(isCaller) {
  await stopWebRTC();

  localStream = await getLocalStreamWithDevice(selectedMicId);
  if (!localStream) return;

  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio.srcObject !== event.streams[0]) {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.muted = globalSpeakerOff;
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
  if (signalChannel) {
    supabase.removeChannel(signalChannel);
    signalChannel = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  const remoteAudio = document.getElementById('remote-audio');
  remoteAudio.srcObject = null;
}

function applyMicMuteToStream(stream) {
  if (!stream) stream = localStream;
  if (!stream) return;
  stream.getAudioTracks().forEach(track => {
    track.enabled = !micMuted;
  });
}

function applySpeakerToRemoteAudio() {
  const remoteAudio = document.getElementById('remote-audio');
  if (!selectedSpeakerId) return;
  if (remoteAudio.setSinkId) {
    remoteAudio.setSinkId(selectedSpeakerId).catch(err => console.warn('Hoparlör ayarlanamadı:', err));
  }
}

async function switchMicrophone(deviceId) {
  selectedMicId = deviceId;

  const newStream = await getLocalStreamWithDevice(deviceId);
  if (!newStream) {
    console.warn('Yeni mikrofon stream\'i alınamadı, eski stream kullanılacak');
    return;
  }

  if (peerConnection) {
    const newTrack = newStream.getAudioTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (error) {
        console.warn('WebRTC track değiştirilemedi:', error);
      }
    } else {
      newStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, newStream);
      });
    }
  }

  if (localStream && localStream !== newStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = newStream;
  applyMicMuteToStream();
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

let cachedDevices = { mics: [], speakers: [] };
let deviceCacheValid = false;

async function getAudioDevices(forceRefresh) {
  try {
    if (deviceCacheValid && !forceRefresh) {
      return cachedDevices;
    }

    await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(track => track.stop());
    }).catch(() => {});

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const speakers = devices.filter(d => d.kind === 'audiooutput');

    cachedDevices = { mics, speakers };
    deviceCacheValid = true;
    return cachedDevices;
  } catch (error) {
    console.warn('Cihazlar taranamadı:', error);
    return { mics: [], speakers: [] };
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  deviceCacheValid = false;
});

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
  const { mics, speakers } = await getAudioDevices(true);

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

document.getElementById('call-mute-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  micMuted = !micMuted;
  document.getElementById('call-mute-btn').classList.toggle('muted', micMuted);
  applyMicMuteToStream();
  broadcastMuteState();

  globalMicOff = micMuted;
  sidebarMicBtn.classList.toggle('muted', globalMicOff);
  sidebarMicBtn.textContent = globalMicOff ? '🔇' : '🎤';
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
  await loadGroupsData();
  subscribeToGroupInvites();
  subscribeToGroupCallNotifications();
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

  userFriendsList = normalizedFriends;

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
  document.getElementById('group-chat-area').classList.add('hidden');
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

document.getElementById('back-to-friends-from-group').addEventListener('click', () => {
  document.getElementById('group-chat-area').classList.add('hidden');
  document.getElementById('friends-area').classList.remove('hidden');

  if (groupChatSubscription) {
    supabase.removeChannel(groupChatSubscription);
    groupChatSubscription = null;
  }
  activeGroup = null;

  document.querySelectorAll('.server-group-icon').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
});

// ===== GRUP MANTIGI =====

// Grup Oluştur butonu (sol üstte "+")
document.getElementById('add-group-btn').addEventListener('click', () => {
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-limit-input').value = '0';
  document.getElementById('create-group-message').textContent = '';
  document.getElementById('create-group-modal').classList.remove('hidden');
});

document.getElementById('cancel-group-btn').addEventListener('click', () => {
  document.getElementById('create-group-modal').classList.add('hidden');
});

document.getElementById('confirm-create-group-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('group-name-input');
  const limitInput = document.getElementById('group-limit-input');
  const messageDiv = document.getElementById('create-group-message');

  const name = nameInput.value.trim();
  let memberLimit = parseInt(limitInput.value, 10);
  if (isNaN(memberLimit) || memberLimit < 0) memberLimit = 0;

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!name) {
    messageDiv.textContent = 'Lütfen bir grup adı gir.';
    messageDiv.classList.add('error');
    return;
  }

  if (!currentUser) return;

  const { data: newGroup, error } = await supabase
    .from('groups')
    .insert({ name: name, created_by: currentUser.id, member_limit: memberLimit })
    .select()
    .single();

  if (error || !newGroup) {
    messageDiv.textContent = 'Grup oluşturulamadı: ' + (error ? error.message : 'bilinmeyen hata');
    messageDiv.classList.add('error');
    return;
  }

  // Kendini gruba sahip (owner) olarak ekle
  const { error: memberError } = await supabase
    .from('group_members')
    .insert({ group_id: newGroup.id, user_id: currentUser.id, status: 'accepted', role: 'owner' });

  if (memberError) {
    messageDiv.textContent = 'Grup oluştu ama üyelik eklenemedi: ' + memberError.message;
    messageDiv.classList.add('error');
    return;
  }

  document.getElementById('create-group-modal').classList.add('hidden');
  loadGroupsData();
});

// Kullanıcının gruplarını yükle
async function loadGroupsData() {
  if (!currentUser) return;

  const { data: memberships } = await supabase
    .from('group_members')
    .select('group_id, role, groups (id, name, created_by, logo_url, member_limit)')
    .eq('user_id', currentUser.id)
    .eq('status', 'accepted');

  userGroups = (memberships || [])
    .filter(m => m.groups)
    .map(m => ({ ...m.groups, myRole: m.role }));

  renderServerGroupIcons(userGroups);
}

// Sol şeritte grup ikonları (Lobi'nin altında)
function renderServerGroupIcons(groups) {
  const listEl = document.getElementById('server-group-list');
  listEl.innerHTML = '';

  groups.forEach(group => {
    const icon = document.createElement('div');
    icon.className = 'server-group-icon';
    icon.setAttribute('data-tooltip', group.name);
    if (group.logo_url) {
      icon.innerHTML = `<img src="${group.logo_url}" alt="${group.name}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
    } else {
      icon.textContent = group.name.charAt(0).toUpperCase();
    }
    icon.addEventListener('click', () => {
      openGroupChat(group);
    });
    listEl.appendChild(icon);
  });
}

// Grup sohbetini aç
async function openGroupChat(group) {
  activeGroup = group;

  document.getElementById('friends-area').classList.add('hidden');
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('group-chat-area').classList.remove('hidden');

  document.getElementById('group-chat-name').textContent = group.name;
  const chatAvatar = document.getElementById('group-chat-avatar');
  if (group.logo_url) {
    chatAvatar.innerHTML = `<img src="${group.logo_url}" alt="${group.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    chatAvatar.textContent = group.name.charAt(0).toUpperCase();
  }

  document.querySelectorAll('.server-group-icon').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-tooltip') === group.name);
  });
  document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));

  await loadGroupMessages();
  subscribeToGroupMessages();
}

// Grup mesajlarını yükle
async function loadGroupMessages() {
  if (!activeGroup) return;

  const { data: messages } = await supabase
    .from('group_messages')
    .select('*, profiles:sender_id (username)')
    .eq('group_id', activeGroup.id)
    .order('created_at', { ascending: true });

  const chatMessages = document.getElementById('group-chat-messages');
  chatMessages.innerHTML = '';

  if (messages) {
    messages.forEach(msg => {
      appendGroupMessageToChat(msg);
    });
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Grup mesajını ekrana ekle
function appendGroupMessageToChat(msg) {
  const chatMessages = document.getElementById('group-chat-messages');
  const bubble = document.createElement('div');
  bubble.className = 'chat-message ' + (msg.sender_id === currentUser.id ? 'sent' : 'received');

  const senderLabel = document.createElement('span');
  senderLabel.className = 'sender-label';
  senderLabel.textContent = msg.profiles ? msg.profiles.username : 'Kullanıcı';

  const textNode = document.createTextNode(msg.content);

  bubble.appendChild(senderLabel);
  bubble.appendChild(textNode);
  chatMessages.appendChild(bubble);
}

// Grup mesajlarını gerçek zamanlı dinle
function subscribeToGroupMessages() {
  if (groupChatSubscription) {
    supabase.removeChannel(groupChatSubscription);
  }

  groupChatSubscription = supabase
    .channel('group-messages-' + activeGroup.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages' }, async (payload) => {
      const msg = payload.new;
      if (!activeGroup || msg.group_id !== activeGroup.id) return;

      const { data: senderProfile } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', msg.sender_id)
        .single();

      msg.profiles = senderProfile;

      appendGroupMessageToChat(msg);
      const chatMessages = document.getElementById('group-chat-messages');
      chatMessages.scrollTop = chatMessages.scrollHeight;
    })
    .subscribe();
}

// Grup mesajı gönder
document.getElementById('group-chat-send-btn').addEventListener('click', sendGroupMessage);
document.getElementById('group-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendGroupMessage();
  }
});

async function sendGroupMessage() {
  const input = document.getElementById('group-chat-input');
  const content = input.value.trim();

  if (!content || !activeGroup || !currentUser) return;

  const { error } = await supabase
    .from('group_messages')
    .insert({
      group_id: activeGroup.id,
      sender_id: currentUser.id,
      content: content
    });

  if (!error) {
    input.value = '';
  }
}

// ===== ARKADAŞ DAVET ETME =====

document.getElementById('group-invite-btn').addEventListener('click', async () => {
  if (!activeGroup) return;

  document.getElementById('invite-friend-message').textContent = '';
  await renderInviteFriendList();
  document.getElementById('invite-friend-modal').classList.remove('hidden');
});

document.getElementById('close-invite-modal-btn').addEventListener('click', () => {
  document.getElementById('invite-friend-modal').classList.add('hidden');
});

async function renderInviteFriendList() {
  const listEl = document.getElementById('invite-friend-list');
  listEl.innerHTML = '';

  if (userFriendsList.length === 0) {
    listEl.innerHTML = '<div class="empty-list">Davet edebileceğin bir arkadaşın yok.</div>';
    return;
  }

  const { data: existingMembers } = await supabase
    .from('group_members')
    .select('user_id, status')
    .eq('group_id', activeGroup.id);

  const existingMap = {};
  let acceptedCount = 0;
  (existingMembers || []).forEach(m => {
    existingMap[m.user_id] = m.status;
    if (m.status === 'accepted') acceptedCount++;
  });

  const limitReached = activeGroup.member_limit && activeGroup.member_limit > 0 && acceptedCount >= activeGroup.member_limit;

  if (limitReached) {
    const warn = document.createElement('div');
    warn.className = 'message error';
    warn.textContent = 'Bu grup üye sınırına ulaştı (' + activeGroup.member_limit + '/' + activeGroup.member_limit + ').';
    listEl.appendChild(warn);
  }

  userFriendsList.forEach(friend => {
    const item = document.createElement('div');
    item.className = 'invite-friend-item';

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar';
    avatar.textContent = friend.username.charAt(0).toUpperCase();

    const nameDiv = document.createElement('div');
    nameDiv.className = 'friend-name';
    nameDiv.textContent = friend.username;

    const inviteBtn = document.createElement('button');
    inviteBtn.className = 'invite-btn';

    const existingStatus = existingMap[friend.id];
    if (existingStatus === 'accepted') {
      inviteBtn.textContent = 'Üye';
      inviteBtn.disabled = true;
    } else if (existingStatus === 'pending') {
      inviteBtn.textContent = 'Davet Edildi';
      inviteBtn.disabled = true;
    } else if (limitReached) {
      inviteBtn.textContent = 'Grup Dolu';
      inviteBtn.disabled = true;
    } else {
      inviteBtn.textContent = 'Davet Et';
      inviteBtn.addEventListener('click', () => inviteFriendToGroup(friend, inviteBtn));
    }

    item.appendChild(avatar);
    item.appendChild(nameDiv);
    item.appendChild(inviteBtn);
    listEl.appendChild(item);
  });
}

async function inviteFriendToGroup(friend, buttonEl) {
  if (!activeGroup || !currentUser) return;

  const { error } = await supabase
    .from('group_members')
    .insert({
      group_id: activeGroup.id,
      user_id: friend.id,
      status: 'pending',
      invited_by: currentUser.id
    });

  const messageDiv = document.getElementById('invite-friend-message');

  if (error) {
    if (error.code === '23505') {
      // Daha önce reddedilmiş bir davet olabilir, statüyü güncelle
      const { error: updateError } = await supabase
        .from('group_members')
        .update({ status: 'pending', invited_by: currentUser.id })
        .eq('group_id', activeGroup.id)
        .eq('user_id', friend.id);

      if (!updateError) {
        buttonEl.textContent = 'Davet Edildi';
        buttonEl.disabled = true;
        messageDiv.textContent = friend.username + ' davet edildi!';
        messageDiv.classList.add('success');
        return;
      }
    }
    messageDiv.textContent = 'Davet gönderilemedi: ' + error.message;
    messageDiv.classList.add('error');
    return;
  }

  buttonEl.textContent = 'Davet Edildi';
  buttonEl.disabled = true;
  messageDiv.textContent = friend.username + ' davet edildi!';
  messageDiv.classList.add('success');
}

// ===== GELEN GRUP DAVETLERİ =====

function subscribeToGroupInvites() {
  if (!currentUser) return;

  groupInviteSubscription = supabase
    .channel('group-invites-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_members' }, async (payload) => {
      const member = payload.new;
      if (member.user_id !== currentUser.id || member.status !== 'pending') return;

      const { data: group } = await supabase
        .from('groups')
        .select('id, name')
        .eq('id', member.group_id)
        .single();

      let inviterName = 'Bir arkadaşın';
      if (member.invited_by) {
        const { data: inviterProfile } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', member.invited_by)
          .single();
        if (inviterProfile) inviterName = inviterProfile.username;
      }

      if (group) {
        showGroupInviteModal(member, group, inviterName);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_members' }, async (payload) => {
      const member = payload.new;
      if (member.user_id !== currentUser.id || member.status !== 'pending') return;

      const { data: group } = await supabase
        .from('groups')
        .select('id, name')
        .eq('id', member.group_id)
        .single();

      let inviterName = 'Bir arkadaşın';
      if (member.invited_by) {
        const { data: inviterProfile } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', member.invited_by)
          .single();
        if (inviterProfile) inviterName = inviterProfile.username;
      }

      if (group) {
        showGroupInviteModal(member, group, inviterName);
      }
    })
    .subscribe();
}

function showGroupInviteModal(member, group, inviterName) {
  document.getElementById('group-invite-avatar').textContent = group.name.charAt(0).toUpperCase();
  document.getElementById('group-invite-name').textContent = group.name;
  document.getElementById('group-invite-text').textContent = inviterName + ' seni bu gruba davet etti';

  document.getElementById('group-invite-incoming-modal').classList.remove('hidden');

  document.getElementById('group-invite-accept-btn').onclick = async () => {
    await supabase
      .from('group_members')
      .update({ status: 'accepted' })
      .eq('group_id', member.group_id)
      .eq('user_id', currentUser.id);

    document.getElementById('group-invite-incoming-modal').classList.add('hidden');
    loadGroupsData();
  };

  document.getElementById('group-invite-decline-btn').onclick = async () => {
    await supabase
      .from('group_members')
      .update({ status: 'declined' })
      .eq('group_id', member.group_id)
      .eq('user_id', currentUser.id);

    document.getElementById('group-invite-incoming-modal').classList.add('hidden');
  };
}

// ===== ARAMA MANTIGI =====

document.getElementById('chat-call-btn').addEventListener('click', async () => {
  if (!activeChatFriend || !currentUser) return;

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
    showActiveCallScreen();
    setCallConnecting(true);
  }
});

function subscribeToIncomingCalls() {
  if (!currentUser) return;

  callSubscription = supabase
    .channel('calls-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls' }, (payload) => {
      const call = payload.new;

      if (call.receiver_id === currentUser.id && call.status === 'pending') {
        showIncomingCallModal(call);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, (payload) => {
      const call = payload.new;

      if (activeCall && call.caller_id === activeCall.caller_id && call.receiver_id === activeCall.receiver_id && call.status === 'active') {
        activeCall = call;
        setCallConnected();
      }

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

function showActiveCallScreen(displayUser) {
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('call-area').classList.remove('hidden');

  micMuted = globalMicOff;
  document.getElementById('call-mute-btn').classList.toggle('muted', micMuted);

  const remoteAudio = document.getElementById('remote-audio');
  remoteAudio.muted = globalSpeakerOff;

  document.getElementById('call-remote-mute').classList.add('hidden');
  closeAllDeviceMenus();

  const username = displayUser?.username || activeChatFriend?.username || 'Kullanıcı';
  document.getElementById('call-name').textContent = username;
  document.getElementById('call-avatar-large').textContent = username.charAt(0).toUpperCase();

  document.getElementById('call-end-btn').onclick = endCall;
}

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

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callSeconds = 0;
  document.getElementById('call-timer').classList.add('hidden');
}

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

function appendMessageToChat(msg) {
  const chatMessages = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = 'chat-message ' + (msg.sender_id === currentUser.id ? 'sent' : 'received');
  bubble.textContent = msg.content;
  chatMessages.appendChild(bubble);
}

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

// ===== GRUP AYARLARI VE ARAMASI =====

document.getElementById('group-call-btn').addEventListener('click', async () => {
  if (!activeGroup || !currentUser) return;
  startGroupCall();
});

document.getElementById('group-settings-btn').addEventListener('click', () => {
  if (!activeGroup) return;

  const isOwner = activeGroup.myRole === 'owner';
  const isMod = activeGroup.myRole === 'moderator';
  const canEdit = isOwner || isMod;

  document.getElementById('edit-group-name-input').value = activeGroup.name;
  document.getElementById('edit-group-name-input').disabled = !canEdit;
  document.getElementById('edit-group-logo-btn').disabled = !canEdit;
  document.getElementById('save-group-settings-btn').style.display = canEdit ? '' : 'none';
  document.getElementById('group-settings-message').textContent = canEdit ? '' : 'Ayarları yalnızca grup sahibi ve yetkililer değiştirebilir.';
  document.getElementById('group-settings-message').className = canEdit ? 'message' : 'message error';

  const logoPreview = document.getElementById('group-logo-preview');
  if (activeGroup.logo_url) {
    logoPreview.innerHTML = `<img src="${activeGroup.logo_url}" alt="Logo">`;
  } else {
    logoPreview.innerHTML = activeGroup.name.charAt(0).toUpperCase();
  }

  renderGroupSettingsMembers();
  document.getElementById('group-settings-modal').classList.remove('hidden');
});

document.getElementById('cancel-group-settings-btn').addEventListener('click', () => {
  document.getElementById('group-settings-modal').classList.add('hidden');
});

document.getElementById('save-group-settings-btn').addEventListener('click', async () => {
  if (!activeGroup || !currentUser) return;

  const newName = document.getElementById('edit-group-name-input').value.trim();
  const messageDiv = document.getElementById('group-settings-message');

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!newName) {
    messageDiv.textContent = 'Grup adı boş olamaz.';
    messageDiv.classList.add('error');
    return;
  }

  const { error } = await supabase
    .from('groups')
    .update({ name: newName })
    .eq('id', activeGroup.id);

  if (error) {
    messageDiv.textContent = 'Hata: ' + error.message;
    messageDiv.classList.add('error');
    return;
  }

  messageDiv.textContent = 'Grup bilgileri güncellendi!';
  messageDiv.classList.add('success');

  activeGroup.name = newName;
  document.getElementById('group-chat-name').textContent = newName;

  if (!activeGroup.logo_url) {
    document.getElementById('group-chat-avatar').textContent = newName.charAt(0).toUpperCase();
  }

  loadGroupsData();

  setTimeout(() => {
    document.getElementById('group-settings-modal').classList.add('hidden');
  }, 1000);
});

document.getElementById('leave-group-btn').addEventListener('click', () => {
  if (!activeGroup || !currentUser) return;
  document.getElementById('leave-group-confirm-modal').classList.remove('hidden');
});

document.getElementById('cancel-leave-group-btn').addEventListener('click', () => {
  document.getElementById('leave-group-confirm-modal').classList.add('hidden');
});

document.getElementById('confirm-leave-group-btn').addEventListener('click', async () => {
  if (!activeGroup || !currentUser) return;

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', activeGroup.id)
    .eq('user_id', currentUser.id);

  if (!error) {
    document.getElementById('leave-group-confirm-modal').classList.add('hidden');
    document.getElementById('group-settings-modal').classList.add('hidden');
    document.getElementById('group-chat-area').classList.add('hidden');
    document.getElementById('friends-area').classList.remove('hidden');
    activeGroup = null;
    loadGroupsData();
  } else {
    alert('Ayrılırken hata oluştu: ' + error.message);
  }
});

// ===== LOGO DEĞİŞTİRME =====

document.getElementById('edit-group-logo-btn').addEventListener('click', () => {
  document.getElementById('group-logo-file-input').click();
});

document.getElementById('group-logo-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !activeGroup) return;

  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target.result;

    const { error } = await supabase
      .from('groups')
      .update({ logo_url: base64 })
      .eq('id', activeGroup.id);

    if (error) {
      alert('Logo kaydedilemedi: ' + error.message);
      return;
    }

    activeGroup.logo_url = base64;

    const logoPreview = document.getElementById('group-logo-preview');
    logoPreview.innerHTML = `<img src="${base64}" alt="Logo">`;

    const chatAvatar = document.getElementById('group-chat-avatar');
    chatAvatar.innerHTML = `<img src="${base64}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;

    document.querySelectorAll('.server-group-icon').forEach(el => {
      if (el.getAttribute('data-tooltip') === activeGroup.name) {
        el.innerHTML = `<img src="${base64}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
      }
    });

    e.target.value = '';
  };
  reader.readAsDataURL(file);
});

async function renderGroupSettingsMembers() {
  const listEl = document.getElementById('group-settings-member-list');
  listEl.innerHTML = '<div class="empty-list">Yükleniyor...</div>';

  if (!activeGroup || !currentUser) return;

  const isOwner = activeGroup.myRole === 'owner';

  const { data: members, error } = await supabase
    .from('group_members')
    .select('user_id, role, profiles:user_id(username)')
    .eq('group_id', activeGroup.id)
    .eq('status', 'accepted');

  if (error || !members) {
    console.error("Üye yükleme hatası:", error);
    listEl.innerHTML = '<div class="empty-list">Üyeler yüklenemedi.</div>';
    return;
  }

  listEl.innerHTML = '';

  members.forEach(m => {
    const isMe = m.user_id === currentUser.id;
    const username = m.profiles ? m.profiles.username : 'Bilinmeyen';
    const memberRole = m.role || 'member';

    const item = document.createElement('div');
    item.className = 'premium-member-item';

    const info = document.createElement('div');
    info.className = 'premium-member-info';

    const avatar = document.createElement('div');
    avatar.className = 'premium-member-avatar';
    avatar.textContent = username.charAt(0).toUpperCase();

    const nameSpan = document.createElement('span');
    nameSpan.textContent = username + (isMe ? ' (Sen)' : '');

    if (memberRole === 'owner') {
      const badge = document.createElement('span');
      badge.className = 'role-badge admin';
      badge.textContent = 'Sahip';
      nameSpan.appendChild(badge);
    } else if (memberRole === 'moderator') {
      const badge = document.createElement('span');
      badge.className = 'role-badge moderator';
      badge.textContent = 'Yetkili';
      nameSpan.appendChild(badge);
    }

    info.appendChild(avatar);
    info.appendChild(nameSpan);
    item.appendChild(info);

    // Sadece sahip, kendisi olmayan ve owner olmayan üyelere sağ tık menüsü açabilir
    if (isOwner && !isMe && memberRole !== 'owner') {
      item.style.cursor = 'context-menu';
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        currentContextMember = { user_id: m.user_id, username: username, role: memberRole };
        currentContextItem = item;

        const promoteBtn = document.getElementById('context-promote-btn');
        if (memberRole === 'moderator') {
          promoteBtn.textContent = '⬇️ Yetkiyi Al';
        } else {
          promoteBtn.textContent = '⭐ Grup Yetkilisi Yap';
        }

        const menu = document.getElementById('custom-context-menu');
        menu.classList.remove('hidden');
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
      });
    }

    listEl.appendChild(item);
  });
}

// ===== SAĞ TIK MENÜSÜ İŞLEMLERİ =====

let currentContextMember = null;
let currentContextItem = null;

document.addEventListener('click', () => {
  const menu = document.getElementById('custom-context-menu');
  if (menu) menu.classList.add('hidden');
});

document.getElementById('context-promote-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  document.getElementById('custom-context-menu').classList.add('hidden');
  if (!currentContextMember || !activeGroup) return;

  const newRole = currentContextMember.role === 'moderator' ? 'member' : 'moderator';
  const actionText = newRole === 'moderator' ? 'yetkili yapmak' : 'yetkisini almak';

  const confirm1 = confirm(`${currentContextMember.username} adlı kullanıcıyı ${actionText} istediğine emin misin?`);
  if (!confirm1) return;

  const { error } = await supabase
    .from('group_members')
    .update({ role: newRole })
    .eq('group_id', activeGroup.id)
    .eq('user_id', currentContextMember.user_id);

  if (!error) {
    renderGroupSettingsMembers();
  } else {
    alert('İşlem başarısız: ' + error.message);
  }
});

document.getElementById('context-kick-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  document.getElementById('custom-context-menu').classList.add('hidden');

  if (!currentContextMember || !activeGroup) return;

  const confirmKick = confirm(currentContextMember.username + ' adlı kullanıcıyı gruptan çıkarmak istediğine emin misin?');
  if (!confirmKick) return;

  const { error: kickErr } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', activeGroup.id)
    .eq('user_id', currentContextMember.user_id);

  if (!kickErr) {
    if (currentContextItem) currentContextItem.remove();
  } else {
    alert('Çıkarılırken hata: ' + kickErr.message);
  }
});

// ===== GRUP SESLİ ARAMA =====

async function startGroupCall() {
  if (!activeGroup || !currentUser) return;

  const { data: call, error } = await supabase
    .from('group_calls')
    .insert({ group_id: activeGroup.id, started_by: currentUser.id, status: 'active' })
    .select()
    .single();

  if (error) {
    alert('Arama başlatılamadı: ' + error.message);
    return;
  }

  activeGroupCallId = call.id;
  openGroupCallModal(activeGroup, currentUser.id);
  subscribeToGroupCall(call.id);
}

function openGroupCallModal(group, starterId) {
  const modal = document.getElementById('group-call-modal');
  document.getElementById('group-call-group-name').textContent = group.name;
  document.getElementById('group-call-status').textContent = 'Aranıyor...';

  const avatar = document.getElementById('group-call-avatar');
  if (group.logo_url) {
    avatar.innerHTML = `<img src="${group.logo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    avatar.textContent = group.name.charAt(0).toUpperCase();
  }

  document.getElementById('group-call-participant-list').innerHTML = '';
  addParticipantToCallUI(currentUser.id, 'Sen');

  modal.classList.remove('hidden');
}

function addParticipantToCallUI(userId, username) {
  const list = document.getElementById('group-call-participant-list');

  if (document.getElementById('gcp-' + userId)) return;

  const wrap = document.createElement('div');
  wrap.className = 'group-call-participant';
  wrap.id = 'gcp-' + userId;

  const av = document.createElement('div');
  av.className = 'group-call-participant-avatar';
  av.textContent = (username || '?').charAt(0).toUpperCase();

  const name = document.createElement('div');
  name.className = 'group-call-participant-name';
  name.textContent = username || 'Kullanıcı';

  wrap.appendChild(av);
  wrap.appendChild(name);
  list.appendChild(wrap);

  const count = list.children.length;
  document.getElementById('group-call-status').textContent = count + ' kişi aramada';
}

function removeParticipantFromCallUI(userId) {
  const el = document.getElementById('gcp-' + userId);
  if (el) el.remove();
  const count = document.getElementById('group-call-participant-list').children.length;
  document.getElementById('group-call-status').textContent = count + ' kişi aramada';
}

function subscribeToGroupCall(callId) {
  if (groupCallSubscription) supabase.removeChannel(groupCallSubscription);

  groupCallSubscription = supabase
    .channel('group-call-' + callId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_calls', filter: `id=eq.${callId}` }, (payload) => {
      if (payload.new.status === 'ended') {
        endGroupCallUI();
      }
    })
    .subscribe();
}

function subscribeToGroupCallNotifications() {
  if (!currentUser) return;

  supabase
    .channel('group-call-notifications-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_calls' }, async (payload) => {
      const call = payload.new;
      if (call.started_by === currentUser.id) return;

      const myGroupIds = userGroups.map(g => g.id);
      if (!myGroupIds.includes(call.group_id)) return;

      const group = userGroups.find(g => g.id === call.group_id);
      if (!group) return;

      const { data: callerProfile } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', call.started_by)
        .single();

      const callerName = callerProfile ? callerProfile.username : 'Biri';

      document.getElementById('group-call-incoming-avatar').textContent = group.name.charAt(0).toUpperCase();
      document.getElementById('group-call-incoming-group-name').textContent = group.name;
      document.getElementById('group-call-incoming-caller').textContent = callerName + ' grup araması başlattı';
      document.getElementById('group-call-incoming-modal').classList.remove('hidden');

      document.getElementById('group-call-join-btn').onclick = () => {
        document.getElementById('group-call-incoming-modal').classList.add('hidden');
        activeGroupCallId = call.id;
        activeGroup = group;
        openGroupCallModal(group, call.started_by);
        subscribeToGroupCall(call.id);
      };

      document.getElementById('group-call-decline-btn').onclick = () => {
        document.getElementById('group-call-incoming-modal').classList.add('hidden');
      };
    })
    .subscribe();
}

function endGroupCallUI() {
  document.getElementById('group-call-modal').classList.add('hidden');
  document.getElementById('group-call-participant-list').innerHTML = '';
  activeGroupCallId = null;
  groupCallMuted = false;
  document.getElementById('group-call-mute-btn').textContent = '🎤';
  if (groupCallSubscription) {
    supabase.removeChannel(groupCallSubscription);
    groupCallSubscription = null;
  }
}

document.getElementById('group-call-end-btn').addEventListener('click', async () => {
  if (!activeGroupCallId) { endGroupCallUI(); return; }

  await supabase
    .from('group_calls')
    .update({ status: 'ended' })
    .eq('id', activeGroupCallId);

  endGroupCallUI();
});

document.getElementById('group-call-mute-btn').addEventListener('click', () => {
  groupCallMuted = !groupCallMuted;
  document.getElementById('group-call-mute-btn').textContent = groupCallMuted ? '🔇' : '🎤';
  document.getElementById('group-call-mute-btn').classList.toggle('muted', groupCallMuted);
});