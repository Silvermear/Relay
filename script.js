const supabase = require('./supabase.js');
const rnnoiseProcessor = require('./rnnoise-processor.js');

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

// ===== MESAJ ARAMA =====

let searchTimeout = null;
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

if (searchInput && searchResults) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      searchResults.classList.add('hidden');
      return;
    }
    searchTimeout = setTimeout(() => performSearch(q), 300);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) {
      searchResults.classList.add('hidden');
    }
  });
}

async function performSearch(q) {
  if (!currentUser) return;
  const results = [];

  const { data: dms } = await supabase
    .from('messages')
    .select('id, sender_id, receiver_id, content, created_at')
    .or('sender_id.eq.' + currentUser.id + ',receiver_id.eq.' + currentUser.id)
    .ilike('content', '%' + q + '%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (dms) {
    const seen = new Set();
    for (const msg of dms) {
      const otherId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const { data: profile } = await supabase
        .from('profiles').select('username, avatar_url').eq('id', otherId).single();
      results.push({
        type: 'dm',
        userId: otherId,
        username: profile?.username || '(silinmiş)',
        avatar_url: profile?.avatar_url || null,
        text: msg.content,
        time: msg.created_at
      });
    }
  }

  const { data: groups } = await supabase
    .from('group_messages')
    .select('id, group_id, sender_id, content, created_at')
    .ilike('content', '%' + q + '%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (groups) {
    const seen = new Set();
    for (const msg of groups) {
      const gid = msg.group_id;
      if (seen.has(gid)) continue;
      seen.add(gid);
      const { data: group } = await supabase
        .from('groups').select('name').eq('id', gid).single();
      results.push({
        type: 'group',
        groupId: gid,
        groupName: group?.name || '(silinmiş)',
        text: msg.content,
        time: msg.created_at
      });
    }
  }

  renderSearchResults(results, q);
}

function renderSearchResults(results, q) {
  searchResults.innerHTML = '';
  searchResults.classList.remove('hidden');

  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-result-empty">Sonuç bulunamadı</div>';
    return;
  }

  results.slice(0, 10).forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-result-item';

    const avatar = document.createElement('div');
    avatar.className = 'search-result-avatar';
    if (r.type === 'dm' && r.avatar_url) {
      avatar.style.backgroundImage = 'url(' + r.avatar_url + ')';
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
    } else {
      avatar.textContent = (r.type === 'dm' ? r.username : r.groupName).charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'search-result-info';

    const name = document.createElement('div');
    name.className = 'search-result-name';
    name.textContent = r.type === 'dm' ? r.username : ('# ' + r.groupName);

    const text = document.createElement('div');
    text.className = 'search-result-text';
    text.textContent = r.text.length > 60 ? r.text.slice(0, 60) + '...' : r.text;

    info.appendChild(name);
    info.appendChild(text);
    item.appendChild(avatar);
    item.appendChild(info);

    item.addEventListener('click', async () => {
      searchResults.classList.add('hidden');
      searchInput.value = '';
      if (r.type === 'dm') {
        openChat(r.userId, r.username, r.avatar_url);
      } else {
        const { data: group } = await supabase.from('groups').select('*').eq('id', r.groupId).single();
        if (group) openGroupChat(group);
      }
    });

    searchResults.appendChild(item);
  });
}

// Giriş yapan kullanıcının bilgisini yükle
let currentUser = null;
let activeChatFriend = null;
let activeChatSubscription = null;
let dmTypingChannel = null;
let activeCall = null;
let callSubscription = null;
let callTimerInterval = null;
let callSeconds = 0;
let micMuted = false;
let selectedMicId = null;
let selectedSpeakerId = null;
let noiseSuppressionEnabled = true; // loadSettings'den sonra güncellenir

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
let kickedGroupIds = new Set();
let groupCallNotifSubscription = null;
const groupCallNotifChannels = new Map();
let activeIncomingCallId = null;

// Çevrimiçi durumu
let onlineUsers = new Set();
let userPresenceData = new Map(); // userId -> { username, status, online_at }
let presenceChannel = null;

// Çoklu arama (multi-call) durumları
let isMultiCall = false;
let multiCallId = null;
let multiCallChannel = null;
let multiPeerConnections = new Map(); // userId -> { pc, audioEl }
let multiCallParticipants = []; // { userId, username }
let userNotifChannel = null;
let pendingMultiCallInvite = null;

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

// ===== AYARLAR =====

const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsContent = document.getElementById('settings-content');
const settingsNav = document.getElementById('settings-nav');
let activeSettingsCategory = 'account';

// Demo settings
let userSettings = loadSettings();
noiseSuppressionEnabled = userSettings.noiseSuppression;

// ===== DURUM SİSTEMİ (AKTİF / BOŞTA / AFK) =====

let userStatus = localStorage.getItem('cumbus_status') || 'online';
let _afkManual = false;
let afkTimer = null;
let lastActivity = Date.now();

const statusBtn = document.getElementById('status-btn');
const statusDropdown = document.getElementById('status-dropdown');

function setStatus(status, manual) {
  if (status !== 'afk') _afkManual = false;
  else if (manual) _afkManual = true;
  userStatus = status;
  localStorage.setItem('cumbus_status', status);
  const icons = { online: '🟢', idle: '🟡', afk: '🔴' };
  const labels = { online: 'Aktif', idle: 'Boşta', afk: 'AFK' };
  statusBtn.textContent = icons[status] || '🟢';
  statusBtn.title = labels[status] || 'Aktif';
  statusDropdown.classList.add('hidden');
  updateStatusDisplay();
  applyStatusNotificationSettings();
  broadcastStatus();
  resetAfkTimer();
}

function updateStatusDisplay() {
  const labels = { online: 'Çevrimiçi', idle: 'Boşta', afk: 'AFK' };
  const dotColors = { online: '#23a55a', idle: '#f0b232', afk: '#ed4245' };
  document.querySelectorAll('.user-status').forEach(el => {
    el.textContent = labels[userStatus] || 'Çevrimiçi';
  });
  // Kullanıcı avatar noktasını güncelle
  const userAvatar = document.querySelector('.user-avatar');
  if (userAvatar) {
    userAvatar.style.setProperty('--status-dot', dotColors[userStatus] || '#23a55a');
  }
}

if (statusBtn && statusDropdown) {
  setStatus(userStatus);

  statusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    statusDropdown.classList.toggle('hidden');
  });

  statusDropdown.querySelectorAll('.status-option').forEach(opt => {
    opt.addEventListener('click', () => setStatus(opt.dataset.status, true));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.status-btn-wrapper')) {
      statusDropdown.classList.add('hidden');
    }
  });
}

// Aktivite algılama
document.addEventListener('mousemove', () => { lastActivity = Date.now(); onUserActivity(); });
document.addEventListener('keydown', () => { lastActivity = Date.now(); onUserActivity(); });
document.addEventListener('click', () => { lastActivity = Date.now(); onUserActivity(); });
document.addEventListener('touchstart', () => { lastActivity = Date.now(); onUserActivity(); });

function onUserActivity() {
  if (_afkManual) return;
  if (userStatus === 'afk') setStatus('online');
  else resetAfkTimer();
}

function resetAfkTimer() {
  if (afkTimer) clearTimeout(afkTimer);
  if (userStatus === 'idle') return;
  const minutes = (userSettings.afkTimeout || 15) * 60 * 1000;
  afkTimer = setTimeout(() => {
    const inCall = !!(activeCall || activeGroupCallId || isMultiCall);
    if (!inCall && userStatus === 'online') {
      setStatus('afk');
    }
  }, minutes);
}

resetAfkTimer();

function applyStatusNotificationSettings() {
  if (userStatus === 'afk') {
    userSettings.notificationSounds = false;
    userSettings.notifMessages = false;
    userSettings.notifCalls = false;
    userSettings.notifGroupInvites = false;
    userSettings.notifFriendRequests = false;
  } else if (userStatus === 'idle') {
    userSettings.notificationSounds = true;
    userSettings.notifMessages = false;
    userSettings.notifCalls = false;
    userSettings.notifGroupInvites = true;
    userSettings.notifFriendRequests = true;
  } else {
    userSettings.notificationSounds = true;
    userSettings.notifMessages = true;
    userSettings.notifCalls = true;
    userSettings.notifGroupInvites = true;
    userSettings.notifFriendRequests = true;
  }
  saveSettings();
  // Ayarlar sayfası açıksa UI'ı güncelle
  if (!settingsOverlay.classList.contains('hidden')) {
    renderSettings(activeSettingsCategory);
  }
}

function broadcastStatus() {
  if (!currentUser) return;
  // Kendi verimizi lokal olarak hemen güncelle
  userPresenceData.set(currentUser.id, {
    username: currentUser.username,
    status: userStatus,
    online_at: new Date().toISOString()
  });
  if (typeof presenceChannel !== 'undefined' && presenceChannel) {
    presenceChannel.track({
      user_id: currentUser.id,
      username: currentUser.username,
      status: userStatus,
      online_at: new Date().toISOString()
    });
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('cumbus_settings')) || getDefaultSettings();
  } catch {
    return getDefaultSettings();
  }
}

function getDefaultSettings() {
  return {
    noiseSuppression: true,
    echoCancellation: true,
    inputVolume: 100,
    outputVolume: 100,
    notificationSounds: true,
    notifMessages: true,
    notifCalls: true,
    notifGroupInvites: true,
    notifFriendRequests: true,
    showReadReceipts: true,
    afkTimeout: 15
  };
}

function saveSettings() {
  localStorage.setItem('cumbus_settings', JSON.stringify(userSettings));
}

function getSettingsNavHtml() {
  return `
    <div class="settings-nav-item ${activeSettingsCategory === 'account' ? 'active' : ''}" data-category="account">👤 Hesabım</div>
    <div class="settings-nav-item ${activeSettingsCategory === 'voice' ? 'active' : ''}" data-category="voice">🎤 Ses</div>
    <div class="settings-nav-item ${activeSettingsCategory === 'notifications' ? 'active' : ''}" data-category="notifications">🔔 Bildirimler</div>
    <div class="settings-nav-item ${activeSettingsCategory === 'advanced' ? 'active' : ''}" data-category="advanced">⚙️ Gelişmiş</div>
  `;
}

function renderSettingsPage(category) {
  if (voiceTestStream && category !== 'voice') {
    stopVoiceTest();
  }
  activeSettingsCategory = category;
  settingsNav.innerHTML = getSettingsNavHtml();
  settingsContent.innerHTML = getSettingsPageContent(category);
  attachSettingsEvents(category);
}

function getSettingsPageContent(category) {
  switch (category) {
    case 'account': return renderAccountSettings();
    case 'voice': return renderVoiceSettings();
    case 'notifications': return renderNotificationSettings();
    case 'advanced': return renderAdvancedSettings();
    default: return renderAccountSettings();
  }
}

// --- HESABIM ---
function renderAccountSettings() {
  const u = (currentUser && currentUser.username) ? currentUser : { username: 'Kullanıcı', id: '?' };
  const displayId = u.id !== '?' ? u.id.substring(0, 6).toUpperCase() : '------';
  const savedAv = localStorage.getItem('cumbus_avatar');
  return `
    <div class="settings-page-title">Hesabım</div>
    <div class="settings-page-desc">Hesap bilgilerini görüntüle ve düzenle</div>

    <div class="settings-avatar-section" id="settings-preview">
      <div class="settings-avatar" id="settings-preview-avatar" style="${savedAv ? `background-image:url(${savedAv});background-size:cover;background-position:center` : ''}">
        ${savedAv ? '' : u.username.charAt(0).toUpperCase()}
      </div>
      <div>
        <div class="settings-preview-username" id="settings-preview-name" style="font-size:18px;font-weight:700;color:#dcddde">${escapeHtml(u.username)}</div>
        <div class="settings-preview-id" style="font-size:12px;color:#6a6a72">ID: ${displayId}</div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Kullanıcı Adı</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Görünen adın</div>
          <div class="settings-row-desc">Arkadaşlarının göreceği isim</div>
        </div>
        <input class="settings-input" id="settings-username-input" value="${escapeHtml(u.username)}" placeholder="Kullanıcı adı" />
      </div>
      <div class="settings-row">
        <button class="settings-btn primary" id="settings-save-username-btn">Kaydet</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Profil Resmi</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Avatar</div>
          <div class="settings-row-desc">Sol alttaki profil fotoğrafını değiştir</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="settings-btn secondary" id="settings-avatar-btn">Resim Seç</button>
          <button class="settings-btn secondary" id="settings-avatar-reset-btn" ${localStorage.getItem('cumbus_avatar') ? '' : 'disabled'}>Sıfırla</button>
        </div>
      </div>
      <div style="font-size:11px;color:#6a6a72;margin-top:−4px">Fotoğraflar 512×512, JPEG %85 kaliteye otomatik düşürülür</div>
      <input type="file" id="settings-avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
    </div>

    <div class="settings-logout-section">
      <button class="settings-btn danger" id="settings-logout-btn">Çıkış Yap</button>
      <span style="font-size:12px;color:#6a6a72;margin-left:12px">Oturumu kapat ve giriş ekranına dön</span>
    </div>
  `;
}

// --- SES ---
function renderVoiceSettings() {
  return `
    <div class="settings-page-title">Ses Ayarları</div>
    <div class="settings-page-desc">Mikrofon, hoparlör ve ses işleme ayarlarını yapılandır</div>

    <div class="settings-section">
      <div class="settings-section-title">Ses Girişi</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Giriş Seviyesi</div>
          <div class="settings-row-desc">Mikrofon ses seviyesi</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" class="settings-slider" id="settings-input-volume" min="0" max="100" value="${userSettings.inputVolume}" />
          <span class="settings-slider-value" id="settings-input-volume-label">${userSettings.inputVolume}%</span>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Mikrofon</div>
          <div class="settings-row-desc">Varsayılan giriş cihazı</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" id="settings-mic-select">
            <option value="default">Varsayılan</option>
          </select>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Ses Çıkışı</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Çıkış Seviyesi</div>
          <div class="settings-row-desc">Hoparlör/kulaklık ses seviyesi</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" class="settings-slider" id="settings-output-volume" min="0" max="100" value="${userSettings.outputVolume}" />
          <span class="settings-slider-value" id="settings-output-volume-label">${userSettings.outputVolume}%</span>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Hoparlör / Kulaklık</div>
          <div class="settings-row-desc">Varsayılan çıkış cihazı</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" id="settings-speaker-select">
            <option value="default">Varsayılan</option>
          </select>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Ses İşleme</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Gürültü Engelleme (RNNoise)</div>
          <div class="settings-row-desc">Arka plan gürültüsünü otomatik olarak azalt</div>
        </div>
        <button class="settings-toggle ${userSettings.noiseSuppression ? 'active' : ''}" id="settings-ns-toggle"></button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Echo Cancellation</div>
          <div class="settings-row-desc">Yankıyı otomatik olarak engelle</div>
        </div>
        <button class="settings-toggle ${userSettings.echoCancellation ? 'active' : ''}" id="settings-ec-toggle"></button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Ses Testi</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Mikrofonunu test et</div>
          <div class="settings-row-desc">Konuş ve kendi sesini duyarak kontrol et</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="voice-test-meter" id="voice-test-meter">
            <div class="voice-test-bar" id="voice-test-bar"></div>
          </div>
          <button class="settings-btn secondary" id="voice-test-btn">▶ Testi Başlat</button>
        </div>
      </div>
    </div>
  `;
}

// --- BİLDİRİMLER ---
function renderNotificationSettings() {
  const ns = userSettings.notificationSounds;
  return `
    <div class="settings-page-title">Bildirim Ayarları</div>
    <div class="settings-page-desc">Bildirim ve ses tercihlerini yönet</div>

    <div class="settings-section">
      <div class="settings-section-title">Genel</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Bildirim Sesleri</div>
          <div class="settings-row-desc">Bütün Sesleri Kapatır (Arama Bildirim vs)</div>
        </div>
        <button class="settings-toggle ${ns ? 'active' : ''}" id="settings-sound-toggle"></button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Okundu Bilgisi</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Okundu Bilgisi</div>
          <div class="settings-row-desc">Mesajların okunduğunu karşı tarafa göster</div>
        </div>
        <button class="settings-toggle ${userSettings.showReadReceipts !== false ? 'active' : ''}" id="settings-read-toggle"></button>
      </div>
    </div>

    <div class="settings-section" style="opacity:${ns ? 1 : 0.4}">
      <div class="settings-section-title">Bildirim Türleri</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Mesaj Sesleri</div>
          <div class="settings-row-desc">Yeni mesaj geldiğinde ses çal</div>
        </div>
        <button class="settings-toggle ${userSettings.notifMessages !== false ? 'active' : ''}" id="settings-ntf-msg" ${ns ? '' : 'disabled'}></button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Arama Sesleri</div>
          <div class="settings-row-desc">Gelen/giden arama ve grup araması sesleri</div>
        </div>
        <button class="settings-toggle ${userSettings.notifCalls !== false ? 'active' : ''}" id="settings-ntf-call" ${ns ? '' : 'disabled'}></button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Grup Davet Sesleri</div>
          <div class="settings-row-desc">Bir gruba davet edildiğinde ses çal</div>
        </div>
        <button class="settings-toggle ${userSettings.notifGroupInvites !== false ? 'active' : ''}" id="settings-ntf-group" ${ns ? '' : 'disabled'}></button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Arkadaşlık İsteği Sesleri</div>
          <div class="settings-row-desc">Arkadaşlık isteği geldiğinde ses çal</div>
        </div>
        <button class="settings-toggle ${userSettings.notifFriendRequests !== false ? 'active' : ''}" id="settings-ntf-friend" ${ns ? '' : 'disabled'}></button>
      </div>
    </div>
  `;
}

// --- GELİŞMİŞ ---
function renderAdvancedSettings() {
  return `
    <div class="settings-page-title">Gelişmiş</div>
    <div class="settings-page-desc">Uygulama bilgisi ve geliştirici seçenekleri</div>

    <div class="settings-section">
      <div class="settings-section-title">Uygulama Hakkında</div>
      <div class="settings-info-box">
        <strong>Cumbus</strong> — Gerçek zamanlı mesajlaşma ve sesli arama uygulaması<br>
        <strong>Sürüm:</strong> 1.0.0<br>
        <strong>Altyapı:</strong> Supabase + WebRTC + RNNoise<br>
        <strong>Platform:</strong> Web / Electron
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">AFK Zaman Aşımı</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">AFK Süresi</div>
          <div class="settings-row-desc">Hareketsiz kalınca AFK olma süresi (dakika)</div>
        </div>
        <select class="settings-select" id="settings-afk-select">
          <option value="5" ${userSettings.afkTimeout === 5 ? 'selected' : ''}>5 dk</option>
          <option value="10" ${userSettings.afkTimeout === 10 ? 'selected' : ''}>10 dk</option>
          <option value="15" ${userSettings.afkTimeout === 15 ? 'selected' : ''}>15 dk</option>
          <option value="20" ${userSettings.afkTimeout === 20 ? 'selected' : ''}>20 dk</option>
        </select>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Depolama</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Önbellek Temizle</div>
          <div class="settings-row-desc">Profil resmi, logo ve ayarları sıfırla</div>
        </div>
        <button class="settings-btn danger" id="settings-clear-cache-btn">Temizle</button>
      </div>
    </div>
  `;
}

function attachSettingsEvents(category) {
  if (category === 'account') {
    const logoutBtn = document.getElementById('settings-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('user');
      localStorage.removeItem('userSettings');
      location.reload();
    });
    const saveBtn = document.getElementById('settings-save-username-btn');
    const nameInput = document.getElementById('settings-username-input');
    const previewName = document.getElementById('settings-preview-name');
    if (nameInput && previewName) {
      nameInput.addEventListener('input', () => {
        previewName.textContent = nameInput.value.trim() || (currentUser?.username || 'Kullanıcı');
      });
    }
    if (saveBtn && nameInput) {
      saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName || newName === currentUser.username) return;
        try {
          const { error } = await supabase.from('profiles').update({ username: newName }).eq('id', currentUser.id);
          if (error) throw error;
          currentUser.username = newName;
          document.getElementById('user-name').textContent = newName;
          // Avatar yoksa (background-image yoksa) ilk harfi güncelle
          const sidebarAvatar = document.getElementById('user-avatar');
          if (!sidebarAvatar.style.backgroundImage || sidebarAvatar.style.backgroundImage === 'none') {
            sidebarAvatar.textContent = newName.charAt(0).toUpperCase();
          }
          document.getElementById('settings-footer-name').textContent = newName;
          if (previewName) previewName.textContent = newName;
          showToast('✅', 'Başarılı', 'Kullanıcı adı güncellendi');
        } catch (e) {
          showToast('❌', 'Hata', 'Güncellenemedi: ' + e.message);
        }
      });
    }
    // Avatar değiştirme
    const avatarBtn = document.getElementById('settings-avatar-btn');
    const avatarFile = document.getElementById('settings-avatar-file');
    const avatarResetBtn = document.getElementById('settings-avatar-reset-btn');

    async function saveAvatarToProfile(dataUrl) {
      try {
        const { error } = await supabase.from('profiles').update({ avatar_url: dataUrl }).eq('id', currentUser.id);
        if (error) console.error('Avatar profil kaydetme hatası:', error);
      } catch (e) {
        console.warn('Avatar kaydedilemedi:', e);
      }
    }
    if (avatarBtn && avatarFile) {
      avatarBtn.addEventListener('click', () => avatarFile.click());
      avatarFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const rawUrl = ev.target.result;
          // Sadece çok büyükse küçült (512KB üstü)
          if (rawUrl.length > 512 * 1024) {
            const img = new Image();
            img.onload = () => {
              const maxSize = 512;
              const size = Math.min(maxSize, Math.min(img.width, img.height));
              const canvas = document.createElement('canvas');
              canvas.width = size;
              canvas.height = size;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#e0a458';
              ctx.fillRect(0, 0, size, size);
              const s = Math.min(img.width, img.height);
              ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              finishAvatar(dataUrl, file.size);
            };
            img.src = rawUrl;
          } else {
            finishAvatar(rawUrl, file.size);
          }
        };
        reader.readAsDataURL(file);

        function finishAvatar(dataUrl, origSize) {
          try { localStorage.setItem('cumbus_avatar', dataUrl); } catch (_) { showToast('❌', 'Hata', 'Avatar çok büyük, kaydedilemedi'); return; }
          applyAvatar(dataUrl);
          saveAvatarToProfile(dataUrl);
          const prev = document.getElementById('settings-preview-avatar');
          if (prev) {
            prev.style.cssText = '';
            prev.textContent = '';
            prev.style.backgroundImage = 'url(' + dataUrl + ')';
            prev.style.backgroundSize = 'cover';
            prev.style.backgroundPosition = 'center';
            prev.style.backgroundRepeat = 'no-repeat';
          }
          avatarResetBtn.disabled = false;
          showToast('✅', 'Başarılı', `Profil resmi güncellendi (${(origSize / 1024).toFixed(0)}KB → ~${(dataUrl.length * 0.75 / 1024).toFixed(0)}KB)`);
        }
      });
    }
    if (avatarResetBtn) {
      avatarResetBtn.addEventListener('click', () => {
        localStorage.removeItem('cumbus_avatar');
        applyAvatar(null);
        avatarResetBtn.disabled = true;
        supabase.from('profiles').update({ avatar_url: null }).eq('id', currentUser.id).then(({ error }) => {
          if (error) console.warn('Avatar temizleme hatası:', error);
        }).catch(() => {});
        const prev = document.getElementById('settings-preview-avatar');
        if (prev) {
          prev.style.cssText = '';
          prev.textContent = (currentUser?.username || 'Kullanıcı').charAt(0).toUpperCase();
        }
        showToast('✅', 'Başarılı', 'Varsayılan avatar geri yüklendi');
      });
    }
  }

  if (category === 'voice') {
    // Gürültü engelleme
    const nsToggle = document.getElementById('settings-ns-toggle');
    if (nsToggle) {
      nsToggle.addEventListener('click', () => {
        userSettings.noiseSuppression = !userSettings.noiseSuppression;
        nsToggle.classList.toggle('active', userSettings.noiseSuppression);
        noiseSuppressionEnabled = userSettings.noiseSuppression;
        saveSettings();
      });
    }
    // Echo cancellation
    const ecToggle = document.getElementById('settings-ec-toggle');
    if (ecToggle) {
      ecToggle.addEventListener('click', () => {
        userSettings.echoCancellation = !userSettings.echoCancellation;
        ecToggle.classList.toggle('active', userSettings.echoCancellation);
        saveSettings();
      });
    }
    // Input volume
    const volIn = document.getElementById('settings-input-volume');
    const volInLabel = document.getElementById('settings-input-volume-label');
    if (volIn && volInLabel) {
      volIn.addEventListener('input', () => {
        userSettings.inputVolume = parseInt(volIn.value);
        volInLabel.textContent = userSettings.inputVolume + '%';
        saveSettings();
      });
    }
    // Output volume
    const volOut = document.getElementById('settings-output-volume');
    const volOutLabel = document.getElementById('settings-output-volume-label');
    if (volOut && volOutLabel) {
      volOut.addEventListener('input', () => {
        userSettings.outputVolume = parseInt(volOut.value);
        volOutLabel.textContent = userSettings.outputVolume + '%';
        const remote = document.getElementById('remote-audio');
        if (remote) remote.volume = userSettings.outputVolume / 100;
        saveSettings();
      });
    }
    // Mikrofon seçimi
    populateDeviceDropdown('settings-mic-select', 'audioinput');
    // Hoparlör seçimi
    populateDeviceDropdown('settings-speaker-select', 'audiooutput');
    // Ses testi
    setupVoiceTest();
  }

  if (category === 'notifications') {
    const toggle = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        userSettings[key] = !userSettings[key];
        el.classList.toggle('active', userSettings[key]);
        saveSettings();
        if (key === 'notificationSounds') {
          renderSettingsPage('notifications');
        }
      });
    };
    toggle('settings-sound-toggle', 'notificationSounds');
    toggle('settings-ntf-msg', 'notifMessages');
    toggle('settings-ntf-call', 'notifCalls');
    toggle('settings-ntf-group', 'notifGroupInvites');
    toggle('settings-ntf-friend', 'notifFriendRequests');
    toggle('settings-read-toggle', 'showReadReceipts');
  }

  if (category === 'advanced') {
    const afkSelect = document.getElementById('settings-afk-select');
    if (afkSelect) {
      afkSelect.addEventListener('change', () => {
        userSettings.afkTimeout = parseInt(afkSelect.value);
        saveSettings();
        resetAfkTimer();
        showToast('✅', 'Ayarlanadı', 'AFK süresi ' + afkSelect.value + ' dk olarak ayarlandı');
      });
    }
    const cacheBtn = document.getElementById('settings-clear-cache-btn');
    if (cacheBtn) {
      cacheBtn.addEventListener('click', () => {
        localStorage.removeItem('cumbus_logo');
        localStorage.removeItem('cumbus_avatar');
        localStorage.removeItem('cumbus_settings');
        applyAvatar(null);
        userSettings = getDefaultSettings();
        saveSettings();
        showToast('🗑️', 'Temizlendi', 'Önbellek ve ayarlar sıfırlandı');
        renderSettingsPage('advanced');
      });
    }
  }
}

let voiceTestStream = null;
let voiceTestCtx = null;
let voiceTestGain = null;
let voiceTestSource = null;
let voiceTestAnalyser = null;
let voiceTestRaf = null;

function setupVoiceTest() {
  const btn = document.getElementById('voice-test-btn');
  const bar = document.getElementById('voice-test-bar');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (voiceTestStream) {
      stopVoiceTest(btn, bar);
      return;
    }
    try {
      voiceTestStream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
      });
      voiceTestCtx = new AudioContext();
      voiceTestSource = voiceTestCtx.createMediaStreamSource(voiceTestStream);
      voiceTestGain = voiceTestCtx.createGain();
      voiceTestGain.gain.value = 0.5;
      voiceTestAnalyser = voiceTestCtx.createAnalyser();
      voiceTestAnalyser.fftSize = 256;
      voiceTestSource.connect(voiceTestGain);
      voiceTestGain.connect(voiceTestAnalyser);
      voiceTestAnalyser.connect(voiceTestCtx.destination);

      btn.textContent = '■ Durdur';
      btn.classList.add('danger');

      const data = new Uint8Array(voiceTestAnalyser.frequencyBinCount);
      function update() {
        if (!voiceTestAnalyser) return;
        voiceTestAnalyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const pct = Math.min(avg / 128, 1);
        bar.style.width = (pct * 100) + '%';
        bar.style.background = pct > 0.6 ? '#da373c' : pct > 0.3 ? '#e0a458' : '#23a55a';
        voiceTestRaf = requestAnimationFrame(update);
      }
      update();
    } catch (e) {
      showToast('❌', 'Hata', 'Mikrofona erişilemedi: ' + e.message);
    }
  });
}

function stopVoiceTest(btn, bar) {
  if (voiceTestRaf) { cancelAnimationFrame(voiceTestRaf); voiceTestRaf = null; }
  if (voiceTestCtx) { voiceTestCtx.close().catch(() => {}); voiceTestCtx = null; }
  if (voiceTestStream) { voiceTestStream.getTracks().forEach(t => t.stop()); voiceTestStream = null; }
  voiceTestSource = null;
  voiceTestGain = null;
  voiceTestAnalyser = null;
  btn = btn || document.getElementById('voice-test-btn');
  bar = bar || document.getElementById('voice-test-bar');
  if (btn) { btn.textContent = '▶ Testi Başlat'; btn.classList.remove('danger'); }
  if (bar) bar.style.width = '0%';
}

async function populateDeviceDropdown(selectId, kind) {
  const select = document.getElementById(selectId);
  if (!select) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const filtered = devices.filter(d => d.kind === kind);
    select.innerHTML = '<option value="default">Varsayılan</option>';
    filtered.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${kind === 'audioinput' ? 'Mikrofon' : 'Hoparlör'} (${d.deviceId.slice(0,8)}...)`;
      select.appendChild(opt);
    });
  } catch {
    // cihaz enumerasyonu desteklenmiyor
  }
}

function applyAvatar(dataUrl) {
  ['user-avatar', 'settings-footer-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.cssText = '';
    el.textContent = '';
    if (dataUrl) {
      el.style.backgroundImage = 'url(' + dataUrl + ')';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.backgroundRepeat = 'no-repeat';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundColor = '';
      el.textContent = ((currentUser && currentUser.username) ? currentUser.username : '?').charAt(0).toUpperCase();
    }
  });
}

// Avatar'ı başlangıçta yükle
const savedAvatar = localStorage.getItem('cumbus_avatar');
if (savedAvatar) applyAvatar(savedAvatar);

// Ayarları aç/kapa
sidebarSettingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);

// Nav butonlarına tıklama (event delegation)
settingsNav.addEventListener('click', (e) => {
  const item = e.target.closest('.settings-nav-item');
  if (item) {
    renderSettingsPage(item.dataset.category);
  }
});

function openSettings() {
  document.getElementById('settings-footer-name').textContent = currentUser?.username || 'Kullanıcı';
  applyAvatar(localStorage.getItem('cumbus_avatar'));
  renderSettingsPage(activeSettingsCategory);
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  if (voiceTestStream) {
    const btn = document.getElementById('voice-test-btn');
    const bar = document.getElementById('voice-test-bar');
    stopVoiceTest(btn, bar);
  }
  settingsOverlay.classList.add('hidden');
}

// Overlay dışına tıkla kapat
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// ESC ile kapat
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
    closeSettings();
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== WEBRTC (gerçek ses bağlantısı) =====

let peerConnection = null;
let localStream = null;
let signalChannel = null;
let groupLocalStream = null;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function getSignalChannelName(callerId, receiverId) {
  return 'webrtc-' + [callerId, receiverId].sort().join('-');
}

async function getLocalStreamWithDevice(deviceId, noiseSuppression) {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  rnnoiseProcessor.destroyNoiseSuppressedStream();

  const ns = noiseSuppression !== undefined ? noiseSuppression : noiseSuppressionEnabled;

  try {
    const constraints = {
      audio: deviceId ? { deviceId: { exact: deviceId }, noiseSuppression: ns, echoCancellation: true } : { noiseSuppression: ns, echoCancellation: true }
    };
    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (ns) {
      try {
        const processedStream = await rnnoiseProcessor.createNoiseSuppressedStream(rawStream);
        applyMicMuteToStream(processedStream);
        return processedStream;
      } catch (e) {
        console.warn('RNNoise işleme hatası, ham akış kullanılacak:', e);
      }
    }
    applyMicMuteToStream(rawStream);
    return rawStream;
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
    .on('broadcast', { event: 'call-promoted' }, async (payload) => {
      const { multiCallId: mId, promotedBy } = payload.payload;
      if (promotedBy === currentUser.id) return;
      // Bu katılımcı için arama çokluya yükseltildi
      await handleCallPromoted(mId, promotedBy);
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
  rnnoiseProcessor.destroyNoiseSuppressedStream();
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
  if (selectedSpeakerId && remoteAudio.setSinkId) {
    remoteAudio.setSinkId(selectedSpeakerId).catch(() => {});
  }
  // Grup aramasındaki tüm uzak ses elemanlarına uygula
  if (selectedSpeakerId) {
    document.querySelectorAll('[id^="group-remote-audio-"]').forEach(el => {
      if (el.setSinkId) el.setSinkId(selectedSpeakerId).catch(() => {});
    });
  }
}

async function switchMicrophone(deviceId) {
  selectedMicId = deviceId;

  const newStream = await getLocalStreamWithDevice(deviceId);
  if (!newStream) {
    console.warn('Yeni mikrofon stream\'i alınamadı, eski stream kullanılacak');
    return;
  }

  // Kişisel arama için
  if (peerConnection) {
    const newTrack = newStream.getAudioTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (error) { console.warn('WebRTC track değiştirilemedi:', error); }
    } else {
      newStream.getTracks().forEach(track => { peerConnection.addTrack(track, newStream); });
    }
  }

  // Grup araması için (tüm peer connection'ları güncelle)
  if (groupPeerConnections.size > 0) {
    const newTrack = newStream.getAudioTracks()[0];
    groupPeerConnections.forEach((conn) => {
      const sender = conn.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) {
        sender.replaceTrack(newTrack).catch(() => {});
      }
    });
  }

  if (localStream && localStream !== newStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = newStream;

  if (groupLocalStream && groupLocalStream !== newStream) {
    groupLocalStream.getTracks().forEach(t => t.stop());
  }
  groupLocalStream = newStream;

  applyMicMuteToStream();
}

// ===== GRUP ARAMASI WebRTC (mesh P2P) =====

const groupPeerConnections = new Map();
let groupSignalChannel = null;

async function startGroupWebRTC(callId) {
  await stopGroupWebRTC();

  groupCallMuted = globalMicOff;
  document.getElementById('group-call-mute-btn').textContent = groupCallMuted ? '🔇' : '🎤';
  document.getElementById('group-call-mute-btn').classList.toggle('muted', groupCallMuted);

  groupLocalStream = await getLocalStreamWithDevice(selectedMicId);
  if (!groupLocalStream) return;
  groupLocalStream.getAudioTracks().forEach(track => { track.enabled = !groupCallMuted; });

  groupSignalChannel = supabase.channel('group-webrtc-' + callId);

  groupSignalChannel
    .on('broadcast', { event: 'join' }, async (payload) => {
      if (payload.payload.userId === currentUser.id || groupPeerConnections.has(payload.payload.userId)) return;
      const pc = await createGroupPC(payload.payload.userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      groupSignalChannel.send({
        type: 'broadcast', event: 'webrtc-offer',
        payload: { from: currentUser.id, to: payload.payload.userId, offer }
      });
    })
    .on('broadcast', { event: 'webrtc-offer' }, async (payload) => {
      const { from, offer } = payload.payload;
      if (from === currentUser.id || groupPeerConnections.has(from)) return;
      const pc = await createGroupPC(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      groupSignalChannel.send({
        type: 'broadcast', event: 'webrtc-answer',
        payload: { from: currentUser.id, to: from, answer }
      });
    })
    .on('broadcast', { event: 'webrtc-answer' }, async (payload) => {
      const { from, answer } = payload.payload;
      if (from === currentUser.id) return;
      const conn = groupPeerConnections.get(from);
      if (conn && conn.pc && !conn.pc.currentRemoteDescription) {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    })
    .on('broadcast', { event: 'webrtc-ice' }, async (payload) => {
      const { from, candidate } = payload.payload;
      if (from === currentUser.id) return;
      const conn = groupPeerConnections.get(from);
      if (conn && conn.pc) {
        try { await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
      }
    });

  groupSignalChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      groupSignalChannel.send({
        type: 'broadcast', event: 'join',
        payload: { userId: currentUser.id }
      });
      document.getElementById('group-call-area-status').textContent = 'Bağlanıldı';
      document.getElementById('group-call-area-status').classList.add('connected');
    }
  });
}

async function createGroupPC(userId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  groupLocalStream.getTracks().forEach(track => pc.addTrack(track, groupLocalStream));

  const audioEl = document.createElement('audio');
  audioEl.id = 'group-remote-audio-' + userId;
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);

  pc.ontrack = (event) => {
    if (audioEl.srcObject !== event.streams[0]) {
      audioEl.srcObject = event.streams[0];
      audioEl.muted = globalSpeakerOff;
      if (selectedSpeakerId && audioEl.setSinkId) {
        audioEl.setSinkId(selectedSpeakerId).catch(() => {});
      }
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && groupSignalChannel) {
      groupSignalChannel.send({
        type: 'broadcast', event: 'webrtc-ice',
        payload: { from: currentUser.id, to: userId, candidate: event.candidate }
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removeGroupParticipant(userId);
    }
  };

  groupPeerConnections.set(userId, { pc, audioEl });
  return pc;
}

function removeGroupParticipant(userId) {
  const conn = groupPeerConnections.get(userId);
  if (!conn) return;
  conn.pc.close();
  if (conn.audioEl.parentNode) conn.audioEl.parentNode.removeChild(conn.audioEl);
  groupPeerConnections.delete(userId);
}

async function stopGroupWebRTC() {
  rnnoiseProcessor.destroyNoiseSuppressedStream();
  if (groupSignalChannel) {
    supabase.removeChannel(groupSignalChannel);
    groupSignalChannel = null;
  }
  groupPeerConnections.forEach((conn) => {
    conn.pc.close();
    if (conn.audioEl.parentNode) conn.audioEl.parentNode.removeChild(conn.audioEl);
  });
  groupPeerConnections.clear();
  if (groupLocalStream) {
    groupLocalStream.getTracks().forEach(t => t.stop());
    groupLocalStream = null;
  }
}

// ===== RINGTONE (kendi ses dosyalarımız) =====

function startOutgoingRingtone() {
  stopAllRingtones();
  if (!shouldPlaySound('call')) return;
  const audio = document.getElementById('ringtone-outgoing');
  audio.currentTime = 0;
  audio.play().catch(err => console.warn('Ringtone çalınamadı:', err));
}

function startIncomingRingtone() {
  stopAllRingtones();
  if (!shouldPlaySound('call')) return;
  const audio = document.getElementById('ringtone-incoming');
  audio.currentTime = 0;
  audio.play().catch(err => console.warn('Ringtone çalınamadı:', err));
}

function stopAllRingtones() {
  const outgoing = document.getElementById('ringtone-outgoing');
  const incoming = document.getElementById('ringtone-incoming');
  if (outgoing) { outgoing.pause(); outgoing.currentTime = 0; }
  if (incoming) { incoming.pause(); incoming.currentTime = 0; }
}

function shouldPlaySound(type) {
  if (userStatus === 'afk') return false;
  if (userStatus === 'idle' && (type === 'call' || type === 'message')) return false;
  if (!userSettings.notificationSounds) return false;
  switch (type) {
    case 'message': return userSettings.notifMessages !== false;
    case 'call': return userSettings.notifCalls !== false;
    case 'group-invite': return userSettings.notifGroupInvites !== false;
    case 'friend-request': return userSettings.notifFriendRequests !== false;
    default: return true;
  }
}

function playNotificationSound(type) {
  if (!shouldPlaySound(type)) return;
  if (type === 'message') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(660, t);
      osc1.frequency.setValueAtTime(880, t + 0.08);
      gain1.gain.setValueAtTime(0, t);
      gain1.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain1.gain.linearRampToValueAtTime(0.15, t + 0.08);
      gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(t);
      osc1.stop(t + 0.25);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1100, t);
      gain2.gain.setValueAtTime(0, t);
      gain2.gain.linearRampToValueAtTime(0.08, t + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(t);
      osc2.stop(t + 0.2);
    } catch {}
  }
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

  // 1:1 görüşmede kişi ekle butonunu göster
  if (!isMultiCall) {
    document.getElementById('call-add-person-btn').classList.remove('hidden');
  }
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

// ===== GÜRÜLTÜ ENGELLEME =====

async function toggleNoiseSuppression() {
  noiseSuppressionEnabled = !noiseSuppressionEnabled;
  userSettings.noiseSuppression = noiseSuppressionEnabled;
  saveSettings();

  const newStream = await getLocalStreamWithDevice(selectedMicId, noiseSuppressionEnabled);
  if (!newStream) {
    noiseSuppressionEnabled = !noiseSuppressionEnabled;
    return;
  }

  const newTrack = newStream.getAudioTracks()[0];

  // Kişisel arama
  if (peerConnection) {
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) sender.replaceTrack(newTrack).catch(() => {});
  }

  // Grup araması (tüm PCs)
  if (groupPeerConnections.size > 0) {
    groupPeerConnections.forEach((conn) => {
      const sender = conn.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack).catch(() => {});
    });
  }

  if (localStream && localStream !== newStream) localStream.getTracks().forEach(t => t.stop());
  if (groupLocalStream && groupLocalStream !== newStream) groupLocalStream.getTracks().forEach(t => t.stop());
  localStream = newStream;
  groupLocalStream = newStream;
  applyMicMuteToStream();

  // UI güncelle
  document.querySelectorAll('.ns-btn').forEach(btn => {
    btn.classList.toggle('active', noiseSuppressionEnabled);
    btn.title = noiseSuppressionEnabled ? 'Gürültü engelleme: Açık' : 'Gürültü engelleme: Kapalı';
  });
}

// ===== ÇEVRİMİÇİ DURUMU =====

function setupPresenceChannel() {
  if (!currentUser) return;
  if (presenceChannel) supabase.removeChannel(presenceChannel);

  presenceChannel = supabase.channel('online-users', {
    config: { presence: { key: currentUser.id } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      onlineUsers = new Set(Object.keys(state));
      userPresenceData.clear();
      for (const [userId, presences] of Object.entries(state)) {
        if (presences.length > 0) {
          userPresenceData.set(userId, presences[0]);
        }
      }
      refreshOnlineStatus();
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      onlineUsers.add(key);
      if (newPresences && newPresences.length > 0) {
        userPresenceData.set(key, newPresences[0]);
      }
      refreshOnlineStatus();
    })
    .on('presence', { event: 'leave' }, ({ key }) => {
      onlineUsers.delete(key);
      userPresenceData.delete(key);
      refreshOnlineStatus();
    });

  presenceChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      const username = document.getElementById('user-name').textContent || 'Kullanıcı';
      userPresenceData.set(currentUser.id, { username, status: userStatus, online_at: new Date().toISOString() });
      await presenceChannel.track({ username, status: userStatus, online_at: new Date().toISOString() });
    }
  });
}

function refreshOnlineStatus() {
  if (!currentUser) return;
  const friends = userFriendsList;
  const onlineFriends = friends.filter(f => onlineUsers.has(f.id));
  const offlineFriends = friends.filter(f => !onlineUsers.has(f.id));

  renderOnlineFriendsList(onlineFriends);
  renderAllFriendsList(onlineFriends, offlineFriends);
  renderDmList(friends);
  updateDmListStatus();
}

function renderAllFriendsList(onlineFriends, offlineFriends) {
  const allPanel = document.getElementById('view-all');
  const label = allPanel.querySelector('.section-label');
  const emptyMsg = allPanel.querySelector('.empty-list');

  label.textContent = 'Tüm Arkadaşlar — ' + (onlineFriends.length + offlineFriends.length);

  const existingCards = allPanel.querySelectorAll('.friend');
  existingCards.forEach(card => card.remove());

  if (onlineFriends.length === 0 && offlineFriends.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';

  onlineFriends.forEach(friend => {
    const item = createFriendCard(friend, 'Çevrimiçi', true);
    allPanel.appendChild(item);
  });
  offlineFriends.forEach(friend => {
    const item = createFriendCard(friend, 'Çevrim Dışı', false);
    allPanel.appendChild(item);
  });
}

function updateDmListStatus() {
  document.querySelectorAll('.dm-item').forEach(item => {
    const friendId = item.dataset.userid;
    const statusEl = item.querySelector('.dm-status');
    if (friendId && statusEl) {
      let statusText = 'Çevrim Dışı';
      let statusClass = 'offline';
      if (onlineUsers.has(friendId)) {
        const pd = userPresenceData.get(friendId);
        const s = pd && pd.status ? pd.status : 'online';
        statusText = s === 'idle' ? 'Boşta' : s === 'afk' ? 'AFK' : 'Çevrimiçi';
        statusClass = s === 'idle' ? 'idle' : s === 'afk' ? 'afk' : 'online';
      }
      statusEl.textContent = statusText;
      statusEl.className = 'dm-status ' + statusClass;
    }
  });
}

// ===== PROFİL GÜNCELLEME ABONELİĞİ (avatar anlık senkron) =====

let profileUpdateSubscription = null;

function subscribeToProfileUpdates() {
  if (!currentUser) return;
  if (profileUpdateSubscription) supabase.removeChannel(profileUpdateSubscription);

  profileUpdateSubscription = supabase
    .channel('profile-updates')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
      const updated = payload.new;
      if (!updated.id) return;
      const isAvatarChange = 'avatar_url' in updated;

      // Arkadaş mı?
      const friend = userFriendsList.find(f => f.id === updated.id);
      if (friend && isAvatarChange && friend.avatar_url !== updated.avatar_url) {
        friend.avatar_url = updated.avatar_url;
        renderFriendsList(userFriendsList);
        renderOnlineFriendsList(userFriendsList);
        renderDmList(userFriendsList);
      }

      // Aktif sohbet açık olan arkadaş mı?
      if (activeChatFriend && activeChatFriend.id === updated.id && isAvatarChange) {
        const chatAvatar = document.getElementById('chat-avatar');
        if (chatAvatar) {
          if (updated.avatar_url) {
            chatAvatar.style.backgroundImage = 'url(' + updated.avatar_url + ')';
            chatAvatar.style.backgroundSize = 'cover';
            chatAvatar.style.backgroundPosition = 'center';
            chatAvatar.textContent = '';
          } else {
            chatAvatar.style.backgroundImage = '';
            chatAvatar.textContent = (activeChatFriend.username || '?').charAt(0).toUpperCase();
          }
        }
      }
    })
    .subscribe();
}

// ===== ÇOKLU ARAMA (Multi-Call / Kişi Ekle) =====

function setupUserNotificationChannel() {
  if (!currentUser) return;
  if (userNotifChannel) supabase.removeChannel(userNotifChannel);
  userNotifChannel = supabase.channel('user-notif-' + currentUser.id, { broadcast: { self: false } });
  userNotifChannel.on('broadcast', { event: 'call-invite' }, handleMultiCallInvite);
  userNotifChannel.subscribe();
}

async function handleCallPromoted(mId, promotedBy) {
  if (!activeCall || isMultiCall) return;
  const otherUserId = activeCall.caller_id === currentUser.id ? activeCall.receiver_id : activeCall.caller_id;

  isMultiCall = true;
  multiCallId = mId;

  // Mevcut bağlantıyı mesh yapısına taşı
  const audioEl = document.createElement('audio');
  audioEl.id = 'multi-remote-audio-' + promotedBy;
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  const existingRemoteAudio = document.getElementById('remote-audio');
  if (existingRemoteAudio && existingRemoteAudio.srcObject) {
    audioEl.srcObject = existingRemoteAudio.srcObject;
  }
  if (selectedSpeakerId && audioEl.setSinkId) audioEl.setSinkId(selectedSpeakerId).catch(() => {});
  multiPeerConnections.set(promotedBy, { pc: peerConnection, audioEl });
  peerConnection = null;

  // Katılımcı listesi
  const myName = document.getElementById('user-name').textContent || currentUser.id;
  const otherName = userFriendsList.find(f => f.id === promotedBy)?.username || promotedBy;
  multiCallParticipants = [
    { userId: currentUser.id, username: myName },
    { userId: promotedBy, username: otherName }
  ];

  // Mesh kanalına bağlan
  multiCallChannel = supabase.channel('multi-webrtc-' + multiCallId);
  setupMultiCallSignaling();
  multiCallChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      multiCallChannel.send({
        type: 'broadcast', event: 'join',
        payload: { userId: currentUser.id }
      });
    }
  });

  showMultiCallActiveUI();
}

function handleMultiCallInvite(payload) {
  if (activeCall || isMultiCall || activeGroupCallId) return;
  const p = payload.payload;
  pendingMultiCallInvite = p;
  document.getElementById('multi-call-invite-name').textContent = p.inviterName || 'Bir kullanıcı';
  document.getElementById('multi-call-invite-avatar').textContent = (p.inviterName || '?')[0].toUpperCase();
  document.getElementById('multi-call-invite-text').textContent =
    p.participantCount > 1
      ? `Seni bir aramaya davet ediyor (${p.participantCount} kişi)`
      : 'Seni bir aramaya davet ediyor';
  document.getElementById('multi-call-invite-modal').classList.remove('hidden');
  startIncomingRingtone();
}

document.getElementById('multi-call-accept-btn').addEventListener('click', async () => {
  if (!pendingMultiCallInvite) return;
  const p = pendingMultiCallInvite;
  pendingMultiCallInvite = null;
  document.getElementById('multi-call-invite-modal').classList.add('hidden');
  stopAllRingtones();
  await joinMultiCall(p.multiCallId, p.invitedBy, p.participantUserIds || []);
});

document.getElementById('multi-call-decline-btn').addEventListener('click', () => {
  pendingMultiCallInvite = null;
  document.getElementById('multi-call-invite-modal').classList.add('hidden');
  stopAllRingtones();
});

async function joinMultiCall(mId, inviterId, existingParticipantIds) {
  isMultiCall = true;
  multiCallId = mId;
  multiCallParticipants = [];

  // Ses akışını başlat
  localStream = await getLocalStreamWithDevice(selectedMicId);
  if (!localStream) { isMultiCall = false; return; }

  // WebRTC mesh kanalına bağlan
  multiCallChannel = supabase.channel('multi-webrtc-' + multiCallId);
  setupMultiCallSignaling();
  multiCallChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      multiCallChannel.send({
        type: 'broadcast', event: 'join',
        payload: { userId: currentUser.id }
      });
    }
  });

  showMultiCallActiveUI();
}

function setupMultiCallSignaling() {
  if (!multiCallChannel) return;

  multiCallChannel.on('broadcast', { event: 'join' }, async (payload) => {
    const { userId } = payload.payload;
    if (userId === currentUser.id || multiPeerConnections.has(userId)) return;

    addMultiCallParticipant(userId);
    const pc = await createMultiPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    multiCallChannel.send({
      type: 'broadcast', event: 'webrtc-offer',
      payload: { from: currentUser.id, to: userId, offer }
    });
  });

  multiCallChannel.on('broadcast', { event: 'webrtc-offer' }, async (payload) => {
    const { from, offer } = payload.payload;
    if (from === currentUser.id || multiPeerConnections.has(from)) return;

    addMultiCallParticipant(from);
    const pc = await createMultiPeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    multiCallChannel.send({
      type: 'broadcast', event: 'webrtc-answer',
      payload: { from: currentUser.id, to: from, answer }
    });
  });

  multiCallChannel.on('broadcast', { event: 'webrtc-answer' }, async (payload) => {
    const { from, answer } = payload.payload;
    if (from === currentUser.id) return;
    const conn = multiPeerConnections.get(from);
    if (conn && !conn.pc.currentRemoteDescription) {
      await conn.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  multiCallChannel.on('broadcast', { event: 'webrtc-ice' }, async (payload) => {
    const { from, candidate } = payload.payload;
    if (from === currentUser.id) return;
    const conn = multiPeerConnections.get(from);
    if (conn && candidate) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  });

  multiCallChannel.on('broadcast', { event: 'participant-left' }, (payload) => {
    const { userId } = payload.payload;
    removeMultiCallParticipant(userId);
  });
}

async function createMultiPeerConnection(userId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const audioEl = document.createElement('audio');
  audioEl.id = 'multi-remote-audio-' + userId;
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  if (selectedSpeakerId && audioEl.setSinkId) audioEl.setSinkId(selectedSpeakerId).catch(() => {});

  pc.ontrack = (event) => {
    if (audioEl.srcObject !== event.streams[0]) {
      audioEl.srcObject = event.streams[0];
      audioEl.muted = globalSpeakerOff;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && multiCallChannel) {
      multiCallChannel.send({
        type: 'broadcast', event: 'webrtc-ice',
        payload: { candidate: event.candidate, from: currentUser.id }
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removeMultiCallParticipant(userId);
    }
  };

  multiPeerConnections.set(userId, { pc, audioEl });
  updateMultiCallUI();
  return pc;
}

function addMultiCallParticipant(userId) {
  if (!multiCallParticipants.find(p => p.userId === userId)) {
    multiCallParticipants.push({ userId, username: userId });
    // Arkadaş listesinden ismi bul
    const friend = userFriendsList.find(f => f.id === userId);
    if (friend) {
      const p = multiCallParticipants.find(p => p.userId === userId);
      if (p) p.username = friend.username;
    }
  }
  updateMultiCallUI();
}

function removeMultiCallParticipant(userId) {
  const conn = multiPeerConnections.get(userId);
  if (conn) {
    conn.pc.close();
    if (conn.audioEl.parentNode) conn.audioEl.parentNode.removeChild(conn.audioEl);
  }
  multiPeerConnections.delete(userId);
  multiCallParticipants = multiCallParticipants.filter(p => p.userId !== userId);
  updateMultiCallUI();
}

function showMultiCallActiveUI() {
  document.getElementById('call-area').classList.remove('hidden');
  document.getElementById('call-area').classList.add('connected');
  document.getElementById('call-status').textContent = 'Çoklu arama';
  document.getElementById('call-add-person-btn').classList.remove('hidden');
  document.getElementById('call-avatar-large').textContent = '#';
  document.getElementById('call-name').textContent = 'Çoklu Arama (' + multiCallParticipants.length + ')';
  updateMultiCallUI();
}

function updateMultiCallUI() {
  document.getElementById('call-add-person-btn').classList.toggle('hidden', !isMultiCall);
  const count = multiCallParticipants.length;
  if (count > 0) {
    document.getElementById('call-name').textContent = 'Çoklu Arama (' + count + ')';
    document.getElementById('call-status').textContent = count + ' kişi';
  }
}

function stopMultiCall() {
  isMultiCall = false;
  multiCallId = null;
  if (multiCallChannel) {
    supabase.removeChannel(multiCallChannel);
    multiCallChannel = null;
  }
  multiPeerConnections.forEach((conn) => {
    conn.pc.close();
    if (conn.audioEl.parentNode) conn.audioEl.parentNode.removeChild(conn.audioEl);
  });
  multiPeerConnections.clear();
  multiCallParticipants = [];
}

// ===== ARAMAYA KİŞİ EKLEME UI =====

document.getElementById('call-add-person-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAddPersonPanel();
});

function toggleAddPersonPanel() {
  const panel = document.getElementById('add-person-panel');
  if (panel.classList.contains('hidden')) {
    showAddPersonPanel();
  } else {
    panel.classList.add('hidden');
  }
}

document.getElementById('add-person-close-btn').addEventListener('click', () => {
  document.getElementById('add-person-panel').classList.add('hidden');
});

document.addEventListener('click', (e) => {
  const panel = document.getElementById('add-person-panel');
  const btn = document.getElementById('call-add-person-btn');
  if (!panel.classList.contains('hidden') &&
      !panel.contains(e.target) &&
      !btn.contains(e.target)) {
    panel.classList.add('hidden');
  }
}, true);

document.getElementById('add-person-search-input').addEventListener('input', () => {
  renderAddPersonList();
});

function showAddPersonPanel() {
  renderAddPersonList();
  document.getElementById('add-person-panel').classList.remove('hidden');
  document.getElementById('add-person-search-input').value = '';
  document.getElementById('add-person-search-input').focus();
}

function renderAddPersonList() {
  const listEl = document.getElementById('add-person-list');
  const search = (document.getElementById('add-person-search-input').value || '').toLowerCase().trim();

  // Mevcut katılımcıları filtrele
  const participantIds = new Set([currentUser.id]);
  multiCallParticipants.forEach(p => participantIds.add(p.userId));

  const available = userFriendsList.filter(f =>
    !participantIds.has(f.id) &&
    (!search || f.username.toLowerCase().includes(search))
  );

  if (available.length === 0) {
    listEl.innerHTML = '<div class="add-person-empty">' +
      (search ? 'Sonuç bulunamadı' : 'Eklenecek arkadaş yok') + '</div>';
    return;
  }

  listEl.innerHTML = available.map(f =>
    '<div class="add-person-item" data-userid="' + f.id + '" data-username="' + f.username + '">' +
      '<div class="add-person-item-avatar">' + f.username.charAt(0).toUpperCase() + '</div>' +
      '<div class="add-person-item-name">' + f.username + '</div>' +
    '</div>'
  ).join('');

  listEl.querySelectorAll('.add-person-item').forEach(el => {
    el.addEventListener('click', () => {
      const userId = el.dataset.userid;
      const username = el.dataset.username;
      inviteToMultiCall(userId, username);
    });
  });
}

async function inviteToMultiCall(userId, username) {
  document.getElementById('add-person-panel').classList.add('hidden');

  if (!isMultiCall) {
    // 1:1 aramayı çoklu aramaya yükselt
    await promoteToMultiCall();
  }

  // Daveti gönder
  const participantUserIds = multiCallParticipants.map(p => p.userId);
  const inviterName = document.getElementById('user-name').textContent || currentUser.id;

  const notifCh = supabase.channel('user-notif-' + userId, { broadcast: { self: false } });
  notifCh.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      notifCh.send({
        type: 'broadcast', event: 'call-invite',
        payload: {
          multiCallId,
          invitedBy: currentUser.id,
          inviterName,
          participantUserIds,
          participantCount: participantUserIds.length + 1
        }
      });
      setTimeout(() => supabase.removeChannel(notifCh), 2000);
    }
  });

  // Varolan katılımcıyı bilgilendir
  if (multiCallChannel) {
    multiCallChannel.send({
      type: 'broadcast', event: 'participant-invited',
      payload: { userId, username, invitedBy: currentUser.id }
    });
  }
}

async function promoteToMultiCall() {
  if (isMultiCall) return;

  const otherUserId = activeCall.caller_id === currentUser.id ? activeCall.receiver_id : activeCall.caller_id;
  const otherUsername = userFriendsList.find(f => f.id === otherUserId)?.username || otherUserId;

  isMultiCall = true;
  multiCallId = 'multi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // Mevcut 1:1 bağlantıyı mesh yapısına taşı
  const audioEl = document.createElement('audio');
  audioEl.id = 'multi-remote-audio-' + otherUserId;
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  const existingRemoteAudio = document.getElementById('remote-audio');
  if (existingRemoteAudio && existingRemoteAudio.srcObject) {
    audioEl.srcObject = existingRemoteAudio.srcObject;
  }
  if (selectedSpeakerId && audioEl.setSinkId) audioEl.setSinkId(selectedSpeakerId).catch(() => {});
  multiPeerConnections.set(otherUserId, { pc: peerConnection, audioEl });

  // Katılımcı listesini oluştur
  multiCallParticipants = [
    { userId: currentUser.id, username: document.getElementById('user-name').textContent || currentUser.id },
    { userId: otherUserId, username: otherUsername }
  ];

  // WebRTC mesh kanalını oluştur
  multiCallChannel = supabase.channel('multi-webrtc-' + multiCallId);
  setupMultiCallSignaling();
  multiCallChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      // Mevcut eşi bilgilendir - arama çokluya yükseltildi
      multiCallChannel.send({
        type: 'broadcast', event: 'join',
        payload: { userId: currentUser.id }
      });
    }
  });

  // Diğer katılımcıyı bilgilendir
  const oldSignalChannel = signalChannel;
  if (oldSignalChannel) {
    oldSignalChannel.send({
      type: 'broadcast', event: 'call-promoted',
      payload: { multiCallId, promotedBy: currentUser.id }
    });
  }

  showMultiCallActiveUI();
}

// Diğer katılımcının call-promoted mesajını işle
function setupCallPromotedHandler() {
  // Bu handler mevcut signalChannel'a eklenir
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
  const gMic = document.getElementById('group-call-mic-device-menu');
  const gSpk = document.getElementById('group-call-speaker-device-menu');
  if (gMic) gMic.classList.add('hidden');
  if (gSpk) gSpk.classList.add('hidden');
  const gMicBtn = document.getElementById('group-call-mic-btn');
  const gSpkBtn = document.getElementById('group-call-speaker-btn');
  if (gMicBtn) gMicBtn.classList.remove('active-menu');
  if (gSpkBtn) gSpkBtn.classList.remove('active-menu');
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

  const micMenus = [
    document.getElementById('mic-device-menu'),
    document.getElementById('group-call-mic-device-menu')
  ];
  const speakerMenus = [
    document.getElementById('speaker-device-menu'),
    document.getElementById('group-call-speaker-device-menu')
  ];

  micMenus.forEach(m => {
    if (!m) return;
    renderDeviceMenu(m, mics, selectedMicId, (id) => {
      switchMicrophone(id);
    }, 'Mikrofon bulunamadı');
  });

  speakerMenus.forEach(m => {
    if (!m) return;
    renderDeviceMenu(m, speakers, selectedSpeakerId, (id) => {
      selectedSpeakerId = id;
      applySpeakerToRemoteAudio();
    }, 'Kulaklık/Hoparlör bulunamadı');
  });
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

document.getElementById('call-ns-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNoiseSuppression();
});

document.getElementById('group-call-ns-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNoiseSuppression();
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
    .select('username, avatar_url')
    .eq('id', user.id)
    .single();

  if (profile) {
    document.getElementById('user-name').textContent = profile.username;
    // Önce localStorage (hızlı), yoksa Supabase'deki avatar_url'i dene
    const localAv = localStorage.getItem('cumbus_avatar');
    if (localAv) {
      applyAvatar(localAv);
    } else if (profile.avatar_url) {
      applyAvatar(profile.avatar_url);
    } else {
      document.getElementById('user-avatar').textContent = profile.username.charAt(0).toUpperCase();
    }
  }

  loadFriendshipsData();
  loadBlockedUsers();
  subscribeToFriendRequests();
  subscribeToIncomingCalls();
  await loadGroupsData();
  subscribeToGroupInvites();
  subscribeToGroupCallNotifications();
  subscribeToGroupKick();
  setupUserNotificationChannel();
  setupPresenceChannel();
  subscribeToProfileUpdates();
}

loadUserProfile();

// Arkadaş Ekle işlemi
const addFriendBtn = document.getElementById('add-friend-btn');

addFriendBtn.addEventListener('click', async () => {
  const usernameInput = document.getElementById('add-friend-input');
  const messageDiv = document.getElementById('add-friend-message');
  const raw = usernameInput.value.trim();

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!raw) {
    messageDiv.textContent = 'Lütfen bir kullanıcı adı gir.';
    messageDiv.classList.add('error');
    return;
  }

  if (!currentUser) {
    messageDiv.textContent = 'Kullanıcı bilgisi yüklenemedi, sayfayı yenile.';
    messageDiv.classList.add('error');
    return;
  }

  // Format: username veya username#ID
  let searchUsername = raw;
  let searchId = null;
  if (raw.includes('#')) {
    const parts = raw.split('#');
    searchUsername = parts[0].trim();
    searchId = parts[1].trim().toUpperCase();
  }

  let query = supabase.from('profiles').select('id, username');
  if (searchId) {
    // ID'ye göre ara — ID = id'nin ilk 6 hanesi (büyük harf)
    query = query.filter('id', 'like', searchId.toLowerCase() + '%');
  } else {
    query = query.eq('username', searchUsername);
  }

  const { data: profiles, error: searchError } = await query.limit(5);

  if (searchError || !profiles || profiles.length === 0) {
    messageDiv.textContent = searchId
      ? 'Bu ID\'ye sahip kullanıcı bulunamadı.'
      : 'Bu kullanıcı adına sahip biri bulunamadı.';
    messageDiv.classList.add('error');
    return;
  }

  // Tam eşleşme öncelikli
  let targetProfile = profiles.find(p => p.username === searchUsername) || profiles[0];

  if (searchId) {
    const match = profiles.find(p => p.id.substring(0, 6).toUpperCase() === searchId);
    if (match) targetProfile = match;
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
    .select('id, user_id, profiles:user_id (username, avatar_url)')
    .eq('friend_id', currentUser.id)
    .eq('status', 'pending');

  const { data: acceptedAsSender } = await supabase
    .from('friendships')
    .select('id, friend_id, profiles:friend_id (username, avatar_url)')
    .eq('user_id', currentUser.id)
    .eq('status', 'accepted');

  const { data: acceptedAsReceiver } = await supabase
    .from('friendships')
    .select('id, user_id, profiles:user_id (username, avatar_url)')
    .eq('friend_id', currentUser.id)
    .eq('status', 'accepted');

  renderPendingRequests(pendingRequests || []);

  const normalizedFriends = [
    ...(acceptedAsSender || []).map(f => ({ id: f.friend_id, username: f.profiles.username, avatar_url: f.profiles.avatar_url })),
    ...(acceptedAsReceiver || []).map(f => ({ id: f.user_id, username: f.profiles.username, avatar_url: f.profiles.avatar_url }))
  ];

  userFriendsList = normalizedFriends;

  renderFriendsList(normalizedFriends);
  renderOnlineFriendsList(normalizedFriends);
  renderDmList(normalizedFriends);
}

// Arkadaşlık isteklerini real-time dinle
let friendRequestSubscription = null;

function subscribeToFriendRequests() {
  if (friendRequestSubscription) {
    supabase.removeChannel(friendRequestSubscription);
  }

  friendRequestSubscription = supabase
    .channel('friend-requests-' + currentUser.id)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'friendships',
      filter: 'friend_id=eq.' + currentUser.id
    }, async (payload) => {
      const req = payload.new;
      if (req.status !== 'pending') return;

      const { data: sender } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', req.user_id)
        .single();

      if (sender) {
        showToast('👤', 'Arkadaşlık İsteği', sender.username + ' seni arkadaş olarak eklemek istiyor', '#e0a458');
        playNotificationSound('friend-request');
      }

      loadFriendshipsData();
    })
    .subscribe();
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
    if (req.profiles.avatar_url) {
      avatar.style.backgroundImage = 'url(' + req.profiles.avatar_url + ')';
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
    } else {
      avatar.textContent = req.profiles.username.charAt(0).toUpperCase();
    }

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
function createFriendCard(friend, statusText, isOnline) {
  const item = document.createElement('div');
  item.className = 'friend';

  let avatarOnlineClass = '';
  let friendStatusText = statusText;
  if (isOnline) {
    const pd = userPresenceData.get(friend.id);
    const s = pd && pd.status ? pd.status : 'online';
    avatarOnlineClass = s === 'idle' ? ' idle' : s === 'afk' ? ' afk' : ' online';
    friendStatusText = s === 'idle' ? 'Boşta' : s === 'afk' ? 'AFK' : statusText;
  } else {
    avatarOnlineClass = '';
    friendStatusText = 'Çevrim Dışı';
  }

  const avatar = document.createElement('div');
  avatar.className = 'friend-avatar' + avatarOnlineClass;
  if (friend.avatar_url) {
    avatar.style.backgroundImage = 'url(' + friend.avatar_url + ')';
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  } else {
    avatar.textContent = friend.username.charAt(0).toUpperCase();
  }

  const info = document.createElement('div');
  info.className = 'friend-info';
  info.innerHTML = '<div class="friend-name">' + friend.username + '</div><div class="friend-status">' + friendStatusText + '</div>';

  const blockBtn = document.createElement('button');
  blockBtn.className = 'block-btn';
  blockBtn.title = 'Engelle';
  blockBtn.textContent = '🚫';
  blockBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    blockUser(friend.id, friend.username);
  });

  item.appendChild(avatar);
  item.appendChild(info);
  item.appendChild(blockBtn);

  item.addEventListener('click', () => {
    openChat(friend.id, friend.username, friend.avatar_url);
  });

  return item;
}

// ===== KULLANICI ENGELLEME =====

async function blockUser(userId, username) {
  if (!confirm(username + ' kullanıcısını engellemek istediğine emin misin?')) return;
  const { error } = await supabase.from('blocked_users').insert({ user_id: currentUser.id, blocked_user_id: userId });
  if (error) {
    if (error.code === '23505') { showToast('ℹ️', 'Zaten Engellenmiş', 'Bu kullanıcı zaten engellenmiş.'); return; }
    showToast('❌', 'Hata', 'Engellenemedi: ' + error.message);
    return;
  }
  showToast('🚫', 'Engellendi', username + ' engellendi.');
  loadBlockedUsers();
  loadFriendshipsData();
}

async function unblockUser(userId, username) {
  if (!confirm(username + ' kullanıcısının engelini kaldırmak istediğine emin misin?')) return;
  const { error } = await supabase.from('blocked_users').delete().eq('user_id', currentUser.id).eq('blocked_user_id', userId);
  if (error) { showToast('❌', 'Hata', error.message); return; }
  showToast('✅', 'Engel Kaldırıldı', username + ' engeli kaldırıldı.');
  loadBlockedUsers();
}

async function loadBlockedUsers() {
  const panel = document.getElementById('view-blocked');
  if (!panel) return;
  const label = panel.querySelector('.section-label');
  const emptyMsg = panel.querySelector('.empty-list');

  const { data: blocks } = await supabase
    .from('blocked_users')
    .select('blocked_user_id')
    .eq('user_id', currentUser.id);

  const blocked = blocks || [];
  label.textContent = 'Engellenen Kullanıcılar — ' + blocked.length;

  panel.querySelectorAll('.friend').forEach(c => c.remove());

  if (blocked.length === 0) { emptyMsg.style.display = 'block'; return; }
  emptyMsg.style.display = 'none';

  blocked.forEach(async (b) => {
    const { data: profile } = await supabase.from('profiles').select('username').eq('id', b.blocked_user_id).single();
    const username = profile?.username || '(bilinmiyor)';
    const item = document.createElement('div');
    item.className = 'friend';

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar';
    avatar.textContent = username.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'friend-info';
    info.innerHTML = '<div class="friend-name">' + username + '</div><div class="friend-status">Engellendi</div>';

    const unblockBtn = document.createElement('button');
    unblockBtn.className = 'block-btn unblock';
    unblockBtn.textContent = '🔓';
    unblockBtn.title = 'Engeli Kaldır';
    unblockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      unblockUser(b.blocked_user_id, username);
    });

    item.appendChild(avatar);
    item.appendChild(info);
    item.appendChild(unblockBtn);
    panel.appendChild(item);
  });
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
    const item = createFriendCard(friend, 'Çevrimiçi', true);
    onlinePanel.appendChild(item);
  });
}

// Tüm arkadaşları göster
function renderFriendsList(friends) {
  const onlineFr = friends.filter(f => onlineUsers.has(f.id));
  const offlineFr = friends.filter(f => !onlineUsers.has(f.id));

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

  onlineFr.forEach(friend => {
    const item = createFriendCard(friend, 'Çevrimiçi', true);
    allPanel.appendChild(item);
  });
  offlineFr.forEach(friend => {
    const item = createFriendCard(friend, 'Çevrim Dışı', false);
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
    item.dataset.userid = friend.id;

    const pd = userPresenceData.get(friend.id);
    const friendStatus = pd && pd.status ? pd.status : null;
    const isOnline = onlineUsers.has(friend.id);
    let statusClass = 'offline';
    let statusText = 'Çevrim Dışı';
    let avatarClass = '';
    if (isOnline && friendStatus === 'idle') { statusClass = 'idle'; statusText = 'Boşta'; avatarClass = ' idle'; }
    else if (isOnline && friendStatus === 'afk') { statusClass = 'afk'; statusText = 'AFK'; avatarClass = ' afk'; }
    else if (isOnline) { statusClass = 'online'; statusText = 'Çevrimiçi'; avatarClass = ' online'; }

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar' + avatarClass;
    if (friend.avatar_url) {
      avatar.style.backgroundImage = 'url(' + friend.avatar_url + ')';
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
    } else {
      avatar.textContent = friend.username.charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'friend-info';
    info.innerHTML = '<div class="friend-name">' + friend.username + '</div><div class="dm-status ' + statusClass + '">' + statusText + '</div>';

    item.appendChild(avatar);
    item.appendChild(info);

    item.addEventListener('click', () => {
      openChat(friend.id, friend.username, friend.avatar_url);
    });

    dmList.appendChild(item);
  });
}

// Sohbet ekranını aç
async function openChat(friendId, friendUsername, friendAvatarUrl) {
  activeChatFriend = { id: friendId, username: friendUsername };

  document.getElementById('friends-area').classList.add('hidden');
  document.getElementById('group-chat-area').classList.add('hidden');
  document.getElementById('chat-area').classList.remove('hidden');

  document.getElementById('chat-username').textContent = friendUsername;
  const chatAvatar = document.getElementById('chat-avatar');
  if (friendAvatarUrl) {
    chatAvatar.style.backgroundImage = 'url(' + friendAvatarUrl + ')';
    chatAvatar.style.backgroundSize = 'cover';
    chatAvatar.style.backgroundPosition = 'center';
    chatAvatar.textContent = '';
  } else {
    chatAvatar.style.backgroundImage = '';
    chatAvatar.textContent = friendUsername.charAt(0).toUpperCase();
  }
  document.getElementById('typing-indicator').classList.add('hidden');

  // Ortak yazıyor kanalı
  const typingChan = 'dm-typing-' + [currentUser.id, friendId].sort().join('-');
  if (dmTypingChannel) supabase.removeChannel(dmTypingChannel);
  dmTypingChannel = supabase.channel(typingChan)
    .on('broadcast', { event: 'typing' }, (payload) => {
      if (payload.payload.userId === currentUser.id) return;
      document.getElementById('typing-indicator').textContent = payload.payload.username + ' yazıyor...';
      document.getElementById('typing-indicator').classList.remove('hidden');
    })
    .on('broadcast', { event: 'stop-typing' }, (payload) => {
      if (payload.payload.userId === currentUser.id) return;
      document.getElementById('typing-indicator').classList.add('hidden');
    })
    .subscribe();

  // Okundu bilgisi: gelen okunmamış mesajları işaretle
  if (userSettings.showReadReceipts !== false) {
    supabase.from('messages')
      .update({ is_read: true })
      .eq('receiver_id', currentUser.id)
      .eq('sender_id', friendId)
      .eq('is_read', false)
      .then(({ error }) => { if (error) console.warn('Okundu güncellenemedi:', error); });
  }

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
  if (dmTypingChannel) {
    supabase.removeChannel(dmTypingChannel);
    dmTypingChannel = null;
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
    .filter(m => m.groups && !kickedGroupIds.has(m.groups.id))
    .map(m => ({ ...m.groups, myRole: m.role }));

  renderServerGroupIcons(userGroups);
  subscribeToGroupCallNotifications();
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
  document.getElementById('group-typing-indicator').classList.add('hidden');
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
  bubble.dataset.msgId = msg.id;
  bubble.dataset.content = msg.content;

  const senderLabel = document.createElement('span');
  senderLabel.className = 'sender-label';
  senderLabel.textContent = msg.profiles ? msg.profiles.username : 'Kullanıcı';

  const textSpan = document.createElement('span');
  textSpan.textContent = msg.content;

  bubble.appendChild(senderLabel);
  bubble.appendChild(textSpan);

  if (msg.sender_id === currentUser.id) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
    bubble.appendChild(actions);

    actions.querySelector('.msg-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'msg-edit-input';
      input.value = msg.content;
      textSpan.replaceWith(input);
      actions.innerHTML = '<button class="msg-save-btn" title="Kaydet">💾</button><button class="msg-cancel-btn" title="İptal">✕</button>';
      input.focus();

      const save = () => {
        const newText = input.value.trim();
        if (!newText || newText === msg.content) { cancel(); return; }
        supabase.from('group_messages').update({ content: newText }).eq('id', msg.id).then(({ error }) => {
          if (!error) {
            msg.content = newText;
            textSpan.textContent = newText;
            input.replaceWith(textSpan);
            bubble.dataset.content = newText;
            actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
          }
        });
      };
      const cancel = () => {
        input.replaceWith(textSpan);
        actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
      };
      actions.querySelector('.msg-save-btn').addEventListener('click', save);
      actions.querySelector('.msg-cancel-btn').addEventListener('click', cancel);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save();
        if (ev.key === 'Escape') cancel();
      });
    });

    actions.querySelector('.msg-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Mesajı silmek istediğine emin misin?')) return;
      supabase.from('group_messages').delete().eq('id', msg.id).then(({ error }) => {
        if (!error) bubble.remove();
      });
    });
  }

  chatMessages.appendChild(bubble);

  if (msg.sender_id !== currentUser.id) {
    setupGroupMessageRealtime(msg.id, bubble, textSpan);
  }
}

function setupGroupMessageRealtime(msgId, bubble, textSpan) {
  if (!window._msgBubbleMap) window._msgBubbleMap = {};
  window._msgBubbleMap['group-' + msgId] = { bubble, textSpan };
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
      document.getElementById('group-typing-indicator').classList.add('hidden');
      if (msg.sender_id !== currentUser.id) {
        playNotificationSound('message');
      }
    })
    .on('broadcast', { event: 'typing' }, (payload) => {
      if (!activeGroup || payload.payload.userId === currentUser.id) return;
      document.getElementById('group-typing-indicator').textContent = payload.payload.username + ' yazıyor...';
      document.getElementById('group-typing-indicator').classList.remove('hidden');
    })
    .on('broadcast', { event: 'stop-typing' }, (payload) => {
      if (!activeGroup || payload.payload.userId === currentUser.id) return;
      document.getElementById('group-typing-indicator').classList.add('hidden');
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_messages' }, (payload) => {
      const updated = payload.new;
      if (!window._msgBubbleMap) return;
      const entry = window._msgBubbleMap['group-' + updated.id];
      if (entry && entry.textSpan && !entry._isEditing) {
        entry.textSpan.textContent = updated.content;
        entry.bubble.dataset.content = updated.content;
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'group_messages' }, (payload) => {
      const deleted = payload.old;
      if (!window._msgBubbleMap) return;
      const entry = window._msgBubbleMap['group-' + deleted.id];
      if (entry && entry.bubble) {
        entry.bubble.remove();
        delete window._msgBubbleMap['group-' + deleted.id];
      }
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

let groupTypingTimeout = null;
document.getElementById('group-chat-input').addEventListener('input', () => {
  if (!activeGroup || !currentUser) return;
  const username = document.getElementById('user-name').textContent || 'Birisi';
  if (groupTypingTimeout) clearTimeout(groupTypingTimeout);
  if (groupChatSubscription) {
    groupChatSubscription.send({
      type: 'broadcast', event: 'typing',
      payload: { userId: currentUser.id, username }
    });
  }
  groupTypingTimeout = setTimeout(() => {
    if (groupChatSubscription) {
      groupChatSubscription.send({
        type: 'broadcast', event: 'stop-typing',
        payload: { userId: currentUser.id }
      });
    }
  }, 1500);
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

  const messageDiv = document.getElementById('invite-friend-message');
  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (activeGroup.member_limit && activeGroup.member_limit > 0) {
    const { count, error: countErr } = await supabase
      .from('group_members')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', activeGroup.id)
      .eq('status', 'accepted');

    if (!countErr && count >= activeGroup.member_limit) {
      messageDiv.textContent = `Grup üye sınırına (${activeGroup.member_limit}) ulaşıldığı için davet gönderilemiyor.`;
      messageDiv.classList.add('error');
      return;
    }
  }

  const { error } = await supabase
    .from('group_members')
    .insert({
      group_id: activeGroup.id,
      user_id: friend.id,
      status: 'pending',
      invited_by: currentUser.id
    });

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
        .select('id, name, member_limit')
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
        .select('id, name, member_limit')
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
  playNotificationSound('group-invite');

  document.getElementById('group-invite-accept-btn').onclick = async () => {
    if (group.member_limit && group.member_limit > 0) {
      const { count, error: countErr } = await supabase
        .from('group_members')
        .select('*', { count: 'exact', head: true })
        .eq('group_id', group.id)
        .eq('status', 'accepted');

      if (!countErr && count >= group.member_limit) {
        showToast('🚫', 'Grup Dolu', `Bu grup üye sınırına (${group.member_limit}) ulaştı.`, '#ed4245');
        document.getElementById('group-invite-incoming-modal').classList.add('hidden');
        return;
      }
    }

    const { error: acceptErr } = await supabase
      .from('group_members')
      .update({ status: 'accepted' })
      .eq('group_id', member.group_id)
      .eq('user_id', currentUser.id);

    if (acceptErr) {
      console.error('Davet kabul edilirken hata:', acceptErr);
      showToast('❌', 'Hata', 'Davet kabul edilirken bir hata oluştu.', '#ed4245');
      return;
    }

    document.getElementById('group-invite-incoming-modal').classList.add('hidden');
    await loadGroupsData();
  };

  document.getElementById('group-invite-decline-btn').onclick = async () => {
    const { error: declineErr } = await supabase
      .from('group_members')
      .update({ status: 'declined' })
      .eq('group_id', member.group_id)
      .eq('user_id', currentUser.id);

    if (declineErr) {
      console.error('Davet reddedilirken hata:', declineErr);
    }

    document.getElementById('group-invite-incoming-modal').classList.add('hidden');
  };
}

// ===== ARAMA MANTIGI =====

document.getElementById('chat-call-btn').addEventListener('click', async () => {
  if (!activeChatFriend || !currentUser) return;

  if (await isBlocked(activeChatFriend.id)) {
    showToast('🚫', 'Engellendi', 'Bu kullanıcıyı arayamazsın.');
    return;
  }

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
    const callerFriend = userFriendsList.find(f => f.id === activeChatFriend?.id);
    showActiveCallScreen({ username: activeChatFriend?.username, avatar_url: callerFriend?.avatar_url });
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
    .select('username, avatar_url')
    .eq('id', call.caller_id)
    .single();

  if (callerProfile) {
    document.getElementById('call-modal-name').textContent = callerProfile.username;
    const ca = document.getElementById('call-modal-avatar');
    if (callerProfile.avatar_url) {
      ca.style.backgroundImage = 'url(' + callerProfile.avatar_url + ')';
      ca.style.backgroundSize = 'cover';
      ca.style.backgroundPosition = 'center';
      ca.textContent = '';
    } else {
      ca.style.backgroundImage = '';
      ca.textContent = callerProfile.username.charAt(0).toUpperCase();
    }
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
    showActiveCallScreen({ username: callerProfile ? callerProfile.username : 'Kullanıcı', avatar_url: callerProfile?.avatar_url });
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
  const caLarge = document.getElementById('call-avatar-large');
  const avatarUrl = displayUser?.avatar_url || null;
  if (avatarUrl) {
    caLarge.style.backgroundImage = 'url(' + avatarUrl + ')';
    caLarge.style.backgroundSize = 'cover';
    caLarge.style.backgroundPosition = 'center';
    caLarge.textContent = '';
  } else {
    caLarge.style.backgroundImage = '';
    caLarge.textContent = username.charAt(0).toUpperCase();
  }

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

  if (isMultiCall) {
    // Çoklu aramada diğerlerine haber ver
    if (multiCallChannel) {
      multiCallChannel.send({
        type: 'broadcast', event: 'participant-left',
        payload: { userId: currentUser.id }
      });
    }
    stopMultiCall();
  }

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
  document.getElementById('call-add-person-btn').classList.add('hidden');
  document.getElementById('add-person-panel').classList.add('hidden');
  activeCall = null;
  isMultiCall = false;
  multiCallId = null;
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
  bubble.dataset.msgId = msg.id;
  bubble.dataset.content = msg.content;

  const textSpan = document.createElement('span');
  textSpan.textContent = msg.content;
  bubble.appendChild(textSpan);

  if (msg.sender_id === currentUser.id) {
    const readBadge = document.createElement('span');
    readBadge.className = 'msg-read-badge';
    readBadge.textContent = msg.is_read ? '✓✓' : '✓';
    bubble.appendChild(readBadge);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
    bubble.appendChild(actions);

    actions.querySelector('.msg-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'msg-edit-input';
      input.value = msg.content;
      textSpan.replaceWith(input);
      actions.innerHTML = '<button class="msg-save-btn" title="Kaydet">💾</button><button class="msg-cancel-btn" title="İptal">✕</button>';
      input.focus();

      const save = () => {
        const newText = input.value.trim();
        if (!newText || newText === msg.content) { cancel(); return; }
        supabase.from('messages').update({ content: newText }).eq('id', msg.id).then(({ error }) => {
          if (!error) {
            msg.content = newText;
            textSpan.textContent = newText;
            input.replaceWith(textSpan);
            bubble.dataset.content = newText;
            actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
          }
        });
      };
      const cancel = () => {
        input.replaceWith(textSpan);
        actions.innerHTML = '<button class="msg-edit-btn" title="Düzenle">✏️</button><button class="msg-delete-btn" title="Sil">🗑️</button>';
      };
      actions.querySelector('.msg-save-btn').addEventListener('click', save);
      actions.querySelector('.msg-cancel-btn').addEventListener('click', cancel);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save();
        if (ev.key === 'Escape') cancel();
      });
    });

    actions.querySelector('.msg-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Mesajı silmek istediğine emin misin?')) return;
      supabase.from('messages').delete().eq('id', msg.id).then(({ error }) => {
        if (!error) bubble.remove();
      });
    });
  }

  chatMessages.appendChild(bubble);

  // Realtime güncellemeleri dinle (düzenleme/silme)
  if (msg.sender_id !== currentUser.id) {
    setupMessageRealtime(msg.id, bubble, textSpan);
  }
}

function setupMessageRealtime(msgId, bubble, textSpan) {
  if (!window._msgBubbleMap) window._msgBubbleMap = {};
  window._msgBubbleMap['dm-' + msgId] = { bubble, textSpan };
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
        document.getElementById('typing-indicator').classList.add('hidden');
        if (msg.sender_id !== currentUser.id) {
          playNotificationSound('message');
        }
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
      const updated = payload.new;
      if (!window._msgBubbleMap) return;
      const entry = window._msgBubbleMap['dm-' + updated.id];
      if (entry && entry.textSpan && !entry._isEditing) {
        entry.textSpan.textContent = updated.content;
        entry.bubble.dataset.content = updated.content;
      }
      if (entry && entry.bubble && updated.is_read) {
        const badge = entry.bubble.querySelector('.msg-read-badge');
        if (badge) badge.textContent = '✓✓';
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
      const deleted = payload.old;
      if (!window._msgBubbleMap) return;
      const entry = window._msgBubbleMap['dm-' + deleted.id];
      if (entry && entry.bubble) {
        entry.bubble.remove();
        delete window._msgBubbleMap['dm-' + deleted.id];
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

let typingTimeout = null;
document.getElementById('chat-input').addEventListener('input', () => {
  if (!activeChatFriend || !currentUser) return;
  const username = document.getElementById('user-name').textContent || 'Birisi';
  if (typingTimeout) clearTimeout(typingTimeout);
  if (dmTypingChannel) {
    dmTypingChannel.send({
      type: 'broadcast', event: 'typing',
      payload: { userId: currentUser.id, username }
    });
  }
  typingTimeout = setTimeout(() => {
    if (dmTypingChannel) {
      dmTypingChannel.send({
        type: 'broadcast', event: 'stop-typing',
        payload: { userId: currentUser.id }
      });
    }
  }, 1500);
});

async function isBlocked(otherUserId) {
  const { data } = await supabase
    .from('blocked_users')
    .select('id')
    .or('and(user_id.eq.' + currentUser.id + ',blocked_user_id.eq.' + otherUserId + '),and(user_id.eq.' + otherUserId + ',blocked_user_id.eq.' + currentUser.id + ')')
    .maybeSingle();
  return !!data;
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();

  if (!content || !activeChatFriend || !currentUser) return;

  if (await isBlocked(activeChatFriend.id)) {
    showToast('🚫', 'Engellendi', 'Bu kullanıcıyla mesajlaşamazsın.');
    return;
  }

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
  document.getElementById('edit-group-limit-input').value = activeGroup.member_limit || 0;
  document.getElementById('edit-group-limit-input').disabled = !canEdit;
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

  const isOwner = activeGroup.myRole === 'owner';
  const isMod = activeGroup.myRole === 'moderator';
  if (!isOwner && !isMod) {
    document.getElementById('group-settings-message').textContent = 'Ayarları yalnızca grup sahibi ve yetkililer değiştirebilir.';
    document.getElementById('group-settings-message').className = 'message error';
    return;
  }

  const newName = document.getElementById('edit-group-name-input').value.trim();
  const limitVal = parseInt(document.getElementById('edit-group-limit-input').value) || 0;
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
    .update({ name: newName, member_limit: limitVal })
    .eq('id', activeGroup.id);

  if (error) {
    messageDiv.textContent = 'Hata: ' + error.message;
    messageDiv.classList.add('error');
    return;
  }

  messageDiv.textContent = 'Grup bilgileri güncellendi!';
  messageDiv.classList.add('success');

  activeGroup.name = newName;
  activeGroup.member_limit = limitVal;
  document.getElementById('group-chat-name').textContent = newName;

  if (!activeGroup.logo_url) {
    document.getElementById('group-chat-avatar').textContent = newName.charAt(0).toUpperCase();
  }

  loadGroupsData();

  setTimeout(() => {
    document.getElementById('group-settings-modal').classList.add('hidden');
  }, 1000);
});

// ===== GRUP AYRILMA VE SİLME MODAL GÜNCELLEME YARDIMCILARI =====

function resetLeaveGroupModalDefault() {
  const modalTitle = document.querySelector('#leave-group-confirm-modal .simple-modal-title');
  const modalText = document.querySelector('#leave-group-confirm-modal .leave-confirm-text');
  const confirmBtn = document.getElementById('confirm-leave-group-btn');
  const iconEl = document.querySelector('#leave-group-confirm-modal .leave-confirm-icon');

  if (iconEl) iconEl.textContent = '😢';
  if (modalTitle) modalTitle.textContent = 'Ayrılmak İstediğine Emin Misin?';
  if (modalText) {
    modalText.innerHTML = `
      Bu gruptan ayrılırsan, sohbetlere ve gruba tekrar 
      <span class="highlight-text">bir yönetici seni tekrar davet edene kadar</span> erişemezsin.
    `;
  }
  if (confirmBtn) {
    confirmBtn.textContent = 'Evet, Ayrıl 👋';
    confirmBtn.style.display = 'block';
  }
}

function setLeaveGroupModalOwnerAlone() {
  const modalTitle = document.querySelector('#leave-group-confirm-modal .simple-modal-title');
  const modalText = document.querySelector('#leave-group-confirm-modal .leave-confirm-text');
  const confirmBtn = document.getElementById('confirm-leave-group-btn');
  const iconEl = document.querySelector('#leave-group-confirm-modal .leave-confirm-icon');

  if (iconEl) iconEl.textContent = '🥺';
  if (modalTitle) modalTitle.textContent = 'Grubu Silmek İster Misin?';
  if (modalText) {
    modalText.innerHTML = 'Bu grupta yalnızsın. Grubu silmek ister misin?';
  }
  if (confirmBtn) {
    confirmBtn.textContent = 'Evet, Grubu Sil 🗑️';
    confirmBtn.style.display = 'block';
  }
}

function setLeaveGroupModalTransfer(members) {
  const modalTitle = document.querySelector('#leave-group-confirm-modal .simple-modal-title');
  const modalText = document.querySelector('#leave-group-confirm-modal .leave-confirm-text');
  const confirmBtn = document.getElementById('confirm-leave-group-btn');
  const iconEl = document.querySelector('#leave-group-confirm-modal .leave-confirm-icon');

  if (iconEl) iconEl.textContent = '👑';
  if (modalTitle) modalTitle.textContent = 'Sahipliği Devret';

  let selectHtml = `
    Bu grubun sahibisin. Ayrılmadan önce sahipliği başka bir üyeye devretmelisin.<br/><br/>
    <select id="transfer-owner-select" class="premium-input" style="width: 100%; margin-top: 10px; background-color: #2f3136; color: #fff; border: 1px solid #202225; padding: 10px; border-radius: 4px; box-sizing: border-box;">
  `;
  members.forEach(member => {
    const username = member.profiles ? member.profiles.username : 'Bilinmeyen Üye';
    selectHtml += `<option value="${member.user_id}">${username}</option>`;
  });
  selectHtml += `</select>`;

  if (modalText) modalText.innerHTML = selectHtml;
  if (confirmBtn) {
    confirmBtn.textContent = 'Devret ve Ayrıl 👋';
    confirmBtn.style.display = 'block';
  }
}

function closeLeaveFlowAndReset() {
  document.getElementById('leave-group-confirm-modal').classList.add('hidden');
  document.getElementById('group-settings-modal').classList.add('hidden');
  document.getElementById('group-chat-area').classList.add('hidden');
  document.getElementById('friends-area').classList.remove('hidden');
  activeGroup = null;
  loadGroupsData();
  resetLeaveGroupModalDefault();
}

document.getElementById('leave-group-btn').addEventListener('click', async () => {
  if (!activeGroup || !currentUser) return;

  const isOwner = activeGroup.myRole === 'owner';

  if (!isOwner) {
    resetLeaveGroupModalDefault();
    document.getElementById('leave-group-confirm-modal').classList.remove('hidden');
  } else {
    try {
      const { data: members, error } = await supabase
        .from('group_members')
        .select('user_id, status, profiles:user_id(username)')
        .eq('group_id', activeGroup.id)
        .eq('status', 'accepted')
        .neq('user_id', currentUser.id);

      if (error) {
        alert('Üyeler yüklenirken hata oluştu: ' + error.message);
        return;
      }

      if (members.length === 0) {
        setLeaveGroupModalOwnerAlone();
      } else {
        setLeaveGroupModalTransfer(members);
      }
      document.getElementById('leave-group-confirm-modal').classList.remove('hidden');
    } catch (err) {
      alert('Bir hata oluştu: ' + err.message);
    }
  }
});

document.getElementById('cancel-leave-group-btn').addEventListener('click', () => {
  document.getElementById('leave-group-confirm-modal').classList.add('hidden');
  resetLeaveGroupModalDefault();
});

document.getElementById('confirm-leave-group-btn').addEventListener('click', async () => {
  if (!activeGroup || !currentUser) return;

  const isOwner = activeGroup.myRole === 'owner';

  if (!isOwner) {
    // Normal Member veya Moderator ayrılıyor
    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', activeGroup.id)
      .eq('user_id', currentUser.id);

    if (!error) {
      closeLeaveFlowAndReset();
    } else {
      alert('Ayrılırken hata oluştu: ' + error.message);
    }
  } else {
    // Owner ayrılıyor
    const transferSelect = document.getElementById('transfer-owner-select');

    if (transferSelect) {
      // Grupta başka üyeler var: Sahipliği devret ve ayrıl
      const newOwnerId = transferSelect.value;
      if (!newOwnerId) {
        alert('Lütfen sahipliği devredeceğiniz bir üye seçin.');
        return;
      }

      // Yeni sahibin rolünü 'owner' yap
      const { error: updateError } = await supabase
        .from('group_members')
        .update({ role: 'owner' })
        .eq('group_id', activeGroup.id)
        .eq('user_id', newOwnerId);

      if (updateError) {
        alert('Sahiplik devredilirken hata oluştu: ' + updateError.message);
        return;
      }

      // Eski sahibi (kendimizi) gruptan sil
      const { error: deleteError } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', activeGroup.id)
        .eq('user_id', currentUser.id);

      if (deleteError) {
        alert('Gruptan ayrılırken hata oluştu: ' + deleteError.message);
        return;
      }

      closeLeaveFlowAndReset();
    } else {
      // Grupta sadece owner var: Grubu tamamen sil
      
      // 1. group_members kaydını sil
      const { error: errMembers } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', activeGroup.id);

      // 2. group_messages kayıtlarını sil
      const { error: errMessages } = await supabase
        .from('group_messages')
        .delete()
        .eq('group_id', activeGroup.id);

      // 3. group_calls kayıtlarını sil
      const { error: errCalls } = await supabase
        .from('group_calls')
        .delete()
        .eq('group_id', activeGroup.id);

      // 4. Grubu groups tablosundan sil
      const { error: errGroup } = await supabase
        .from('groups')
        .delete()
        .eq('id', activeGroup.id);

      if (errGroup) {
        alert('Grup silinirken hata oluştu: ' + errGroup.message);
        return;
      }

      closeLeaveFlowAndReset();
    }
  }
});

// ===== LOGO DEĞİŞTİRME =====

document.getElementById('edit-group-logo-btn').addEventListener('click', () => {
  document.getElementById('group-logo-file-input').click();
});

document.getElementById('group-logo-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !activeGroup) return;

  const isOwner = activeGroup.myRole === 'owner';
  const isMod = activeGroup.myRole === 'moderator';
  if (!isOwner && !isMod) {
    alert('Logoyu yalnızca grup sahibi ve yetkililer değiştirebilir.');
    e.target.value = '';
    return;
  }

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
      badge.textContent = 'Kurucu';
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
    console.log('✅ Üye başarıyla silindi (gruptan atıldı)');
    if (currentContextItem) currentContextItem.remove();

    // Atılan kişiye bildirim gönder
    const kickChannel = supabase.channel('group-kick-' + currentContextMember.user_id);
    kickChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await kickChannel.send({
          type: 'broadcast',
          event: 'member-kicked',
          payload: { groupId: activeGroup.id }
        });
        setTimeout(() => supabase.removeChannel(kickChannel), 1000);
      }
    });
  } else {
    console.error('❌ Kick hatası:', kickErr);
    alert('Çıkarılırken hata: ' + kickErr.message + ' (Kod: ' + kickErr.code + ')');
  }
});

// ===== GRUPTAN ATILMA BİLDİRİMİ =====

function subscribeToGroupKick() {
  if (!currentUser) return;

  // Broadcast ile anlık bildirim
  supabase
    .channel('group-kick-' + currentUser.id)
    .on('broadcast', { event: 'member-kicked' }, (payload) => {
      const kickedGroupId = payload.payload.groupId;
      kickedGroupIds.add(kickedGroupId);
      if (activeGroup && activeGroup.id === kickedGroupId) {
        showToast('🚫', 'Gruptan Çıkarıldınız!', activeGroup.name + ' grubundan çıkarıldınız.', '#ed4245');
        closeGroupChat();
      }
      loadGroupsData();
    })
    .subscribe();

  // DB üzerinden de dinle (yedek mekanizma)
  supabase
    .channel('group-members-kick-' + currentUser.id)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'group_members', filter: 'user_id=eq.' + currentUser.id }, (payload) => {
      const deletedGroupId = payload.old.group_id;
      kickedGroupIds.add(deletedGroupId);
      if (activeGroup && activeGroup.id === deletedGroupId) {
        showToast('🚫', 'Gruptan Çıkarıldınız!', 'Gruptan çıkarıldınız.', '#ed4245');
        closeGroupChat();
      }
      loadGroupsData();
    })
    .subscribe();
}

function closeGroupChat() {
  document.getElementById('group-chat-area').classList.add('hidden');
  document.getElementById('friends-area').classList.remove('hidden');
  if (groupChatSubscription) {
    supabase.removeChannel(groupChatSubscription);
    groupChatSubscription = null;
  }
  activeGroup = null;
  document.querySelectorAll('.server-group-icon').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
}

// ===== GRUP SESLİ ARAMA =====

function startGroupCallRingtone(isOutgoing) {
  if (!shouldPlaySound('call')) return;
  const audio = document.getElementById('ringtone-group');
  audio.currentTime = 0;
  audio.play().catch(err => console.warn('Grup ringtone çalınamadı:', err));
}

function stopGroupCallRingtone() {
  const audio = document.getElementById('ringtone-group');
  audio.pause();
  audio.currentTime = 0;
}

function showGroupCallConfirm(group) {
  document.getElementById('group-call-confirm-avatar').textContent = group.name.charAt(0).toUpperCase();
  if (group.logo_url) {
    document.getElementById('group-call-confirm-avatar').innerHTML = `<img src="${group.logo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  }
  document.getElementById('group-call-confirm-name').textContent = group.name;
  document.getElementById('group-call-confirm-status').textContent = 'Aramaya hazır';
  document.getElementById('group-call-area-bg').style.backgroundImage = 'url("grup-aramasi-arkaplan.png")';
  document.getElementById('group-call-incoming').classList.add('hidden');
  document.getElementById('group-call-confirm').classList.remove('hidden');
  document.getElementById('group-call-active').classList.add('hidden');
  document.getElementById('group-call-controls').classList.add('hidden');
  document.getElementById('group-call-area').classList.remove('hidden');
}

function showGroupCallIncomingArea(group, callerName, callId) {
  if (activeIncomingCallId) return;
  activeIncomingCallId = callId;

  const incomingAvatar = document.getElementById('group-call-incoming-avatar');
  if (group.logo_url) {
    incomingAvatar.innerHTML = `<img src="${group.logo_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    incomingAvatar.textContent = group.name.charAt(0).toUpperCase();
  }
  document.getElementById('group-call-incoming-name').textContent = group.name;
  document.getElementById('group-call-incoming-status').textContent = callerName;
  document.getElementById('group-call-area-bg').style.backgroundImage = 'url("grup-aramasi-arkaplan.png")';
  document.getElementById('group-call-incoming').classList.remove('hidden');
  document.getElementById('group-call-confirm').classList.add('hidden');
  document.getElementById('group-call-active').classList.add('hidden');
  document.getElementById('group-call-controls').classList.add('hidden');
  document.getElementById('group-call-area').classList.remove('hidden');
  startGroupCallRingtone();

  document.getElementById('group-call-join-btn').onclick = () => {
    activeIncomingCallId = null;
    document.getElementById('group-call-incoming').classList.add('hidden');
    stopGroupCallRingtone();
    activeGroupCallId = callId;
    activeGroup = group;
    showGroupCallActiveArea(group);
    startGroupCallTimer();
    subscribeToGroupCall(callId);
    startGroupWebRTC(callId);
  };

  document.getElementById('group-call-decline-btn').onclick = () => {
    activeIncomingCallId = null;
    hideGroupCallActiveArea();
    stopGroupCallRingtone();
  };
}

function showGroupCallActiveArea(group) {
  document.getElementById('group-call-area').classList.remove('hidden');
  document.getElementById('group-call-confirm').classList.add('hidden');
  document.getElementById('group-call-incoming').classList.add('hidden');
  document.getElementById('group-call-active').classList.remove('hidden');
  document.getElementById('group-call-controls').classList.remove('hidden');
  document.getElementById('group-call-area-bg').style.backgroundImage = 'url("grup-aramasi-arkaplan.png")';

  document.getElementById('group-call-area-name').textContent = group.name;
  document.getElementById('group-call-area-status').textContent = 'Bağlanıyor...';
  document.getElementById('group-call-area-status').classList.remove('connected');
  document.getElementById('group-call-area-timer').classList.add('hidden');

  const avatarLarge = document.getElementById('group-call-avatar-large');
  if (group.logo_url) {
    avatarLarge.innerHTML = `<img src="${group.logo_url}" alt="${group.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    avatarLarge.textContent = group.name.charAt(0).toUpperCase();
  }

  document.getElementById('group-call-mic-btn').classList.remove('active-menu');
  document.getElementById('group-call-mic-device-menu').classList.add('hidden');
  document.getElementById('group-call-speaker-btn').classList.remove('active-menu');
  document.getElementById('group-call-speaker-device-menu').classList.add('hidden');
}

function hideGroupCallActiveArea() {
  document.getElementById('group-call-area').classList.add('hidden');
  document.getElementById('group-call-incoming').classList.add('hidden');
  document.getElementById('group-call-confirm').classList.add('hidden');
  document.getElementById('group-call-active').classList.add('hidden');
  document.getElementById('group-call-controls').classList.add('hidden');
}

function clearGroupCallUI() {
  document.getElementById('group-call-area-timer').classList.add('hidden');
  document.getElementById('group-call-area-timer').textContent = '00:00';
  stopGroupCallRingtone();
  if (groupCallTimerInterval) {
    clearInterval(groupCallTimerInterval);
    groupCallTimerInterval = null;
  }
  groupCallSeconds = 0;
}

let groupCallTimerInterval = null;
let groupCallSeconds = 0;

function startGroupCallTimer() {
  groupCallSeconds = 0;
  const timerEl = document.getElementById('group-call-area-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = '00:00';
  if (groupCallTimerInterval) clearInterval(groupCallTimerInterval);
  groupCallTimerInterval = setInterval(() => {
    groupCallSeconds++;
    const minutes = Math.floor(groupCallSeconds / 60).toString().padStart(2, '0');
    const seconds = (groupCallSeconds % 60).toString().padStart(2, '0');
    timerEl.textContent = minutes + ':' + seconds;
  }, 1000);
}

function subscribeToGroupCallNotifications() {
  if (!currentUser) return;

  // postgres_changes yedek kanal (yavaş ama garantili)
  if (!groupCallNotifSubscription) {
    groupCallNotifSubscription = supabase
      .channel('group-call-notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_calls' }, async (payload) => {
        const call = payload.new;
        if (call.started_by === currentUser.id) return;
        const grp = userGroups.find(g => g.id === call.group_id);
        if (!grp) return;
        const { data: callerProfile } = await supabase
          .from('profiles').select('username').eq('id', call.started_by).single();
        showGroupCallIncomingArea(grp, callerProfile ? callerProfile.username : 'Biri', call.id);
      })
      .subscribe();
  }

  // Broadcast kanalları (anında bildirim)
  userGroups.forEach(group => {
    if (groupCallNotifChannels.has(group.id)) return;

    const ch = supabase.channel('group-call-broadcast-' + group.id, {
      config: { broadcast: { self: false } }
    });
    ch.on('broadcast', { event: 'call-started' }, (payload) => {
      if (payload.started_by === currentUser.id) return;
      if (!payload.call_id) return;
      showGroupCallIncomingArea(group, payload.caller_name || 'Biri', payload.call_id);
    });
    ch.subscribe();
    groupCallNotifChannels.set(group.id, ch);
  });
}

async function startGroupCall() {
  if (!activeGroup || !currentUser || activeGroupCallId) return;

  const { data: call, error } = await supabase
    .from('group_calls')
    .insert({ group_id: activeGroup.id, started_by: currentUser.id, status: 'active' })
    .select()
    .single();

  if (error) {
    showToast('❌', 'Hata', 'Arama başlatılamadı: ' + error.message, '#ed4245');
    return;
  }

  activeGroupCallId = call.id;
  showGroupCallActiveArea(activeGroup);
  startGroupCallTimer();
  subscribeToGroupCall(call.id);
  startGroupWebRTC(call.id);

  // Broadcast ile anında bildirim gönder
  const bcast = groupCallNotifChannels.get(activeGroup.id);
  if (bcast) {
    const { data: callerProfile } = await supabase
      .from('profiles').select('username').eq('id', currentUser.id).single();
    bcast.send({
      type: 'broadcast',
      event: 'call-started',
      payload: {
        call_id: call.id,
        started_by: currentUser.id,
        caller_name: callerProfile ? callerProfile.username : 'Biri'
      }
    });
  }
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

function endGroupCallUI() {
  hideGroupCallActiveArea();
  clearGroupCallUI();
  stopGroupWebRTC();
  activeGroupCallId = null;
  groupCallMuted = false;
  document.getElementById('group-call-mute-btn').textContent = '🔇';
  document.getElementById('group-call-mute-btn').classList.remove('muted');
  if (groupCallSubscription) {
    supabase.removeChannel(groupCallSubscription);
    groupCallSubscription = null;
  }
  stopGroupCallRingtone();
}

document.getElementById('group-call-area-end-btn').addEventListener('click', async () => {
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
  if (groupLocalStream) {
    groupLocalStream.getAudioTracks().forEach(track => { track.enabled = !groupCallMuted; });
  }
});

document.getElementById('group-call-mic-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = document.getElementById('group-call-mic-device-menu');
  const isHidden = menu.classList.contains('hidden');
  closeAllDeviceMenus();

  if (isHidden) {
    await setupDeviceMenus();
    menu.classList.remove('hidden');
    document.getElementById('group-call-mic-btn').classList.add('active-menu');
  }
});

document.getElementById('group-call-speaker-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = document.getElementById('group-call-speaker-device-menu');
  const isHidden = menu.classList.contains('hidden');
  closeAllDeviceMenus();

  if (isHidden) {
    await setupDeviceMenus();
    menu.classList.remove('hidden');
    document.getElementById('group-call-speaker-btn').classList.add('active-menu');
  }
});

// ===== TOAST BİLDİRİM =====

// RNNoise'i ön yükle (ilk aramada gecikme olmasın)
rnnoiseProcessor.ensureRnnoise().then(() => {
  console.log('RNNoise WASM yüklendi');
}).catch(err => {
  console.warn('RNNoise yüklenemedi, gürültü engelleme kullanılamayacak:', err);
  noiseSuppressionEnabled = false;
  document.querySelectorAll('.ns-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.classList.add('disabled');
    btn.title = 'Gürültü engelleme kullanılamıyor';
  });
});

function showToast(icon, title, text, borderColor) {
  const container = document.getElementById('toast-container') || (() => {
    const el = document.createElement('div');
    el.id = 'toast-container';
    el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();

  const toast = document.createElement('div');
  toast.className = 'toast';
  if (borderColor) toast.style.borderColor = borderColor;
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-text">${text}</div>
    </div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4000);
}