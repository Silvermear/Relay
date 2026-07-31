const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Relay',
    icon: 'icon.png',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('login.html');
  win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  console.log('🚀 Relay açıldı.');
  console.log('🔍 Güncelleme kontrolü başlatılıyor...');

  autoUpdater.checkForUpdates();
});

// Güncelleme kontrolü başladı
autoUpdater.on('checking-for-update', () => {
  console.log('🔍 Güncelleme kontrol ediliyor...');
});

// Güncelleme bulunduğunda
autoUpdater.on('update-available', (info) => {
  console.log('🆕 Yeni güncelleme bulundu!');
  console.log(info);
});

// Güncelleme bulunamadığında
autoUpdater.on('update-not-available', (info) => {
  console.log('✅ Güncelleme bulunamadı.');
  console.log(info);
});

// İndirme ilerlemesi
autoUpdater.on('download-progress', (progress) => {
  console.log(
    `📥 İndiriliyor: ${progress.percent.toFixed(1)}% (${Math.round(progress.transferred / 1024 / 1024)} MB / ${Math.round(progress.total / 1024 / 1024)} MB)`
  );
});

// Güncelleme indirildiğinde, kullanıcıya sor
autoUpdater.on('update-downloaded', () => {
  console.log('✅ Güncelleme indirildi.');

  dialog.showMessageBox({
    type: 'info',
    title: 'Güncelleme Hazır',
    message: 'Yeni bir Relay güncellemesi indirildi. Şimdi yeniden başlatıp kurmak ister misin?',
    buttons: ['Şimdi Yeniden Başlat', 'Daha Sonra']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// Hata durumunda (internet yoksa vs.)
autoUpdater.on('error', (error) => {
  console.log('❌ Güncelleme kontrolü hatası:');
  console.log(error);
});