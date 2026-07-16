const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Cümbüş',
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
  autoUpdater.checkForUpdatesAndNotify();
});

// Güncelleme bulunduğunda
autoUpdater.on('update-available', () => {
  console.log('Yeni güncelleme bulundu, indiriliyor...');
});

// Güncelleme indirildiğinde, kullanıcıya sor
autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Güncelleme Hazır',
    message: 'Yeni bir Cümbüş güncellemesi indirildi. Şimdi yeniden başlatıp kurmak ister misin?',
    buttons: ['Şimdi Yeniden Başlat', 'Daha Sonra']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// Hata durumunda (internet yoksa vs.)
autoUpdater.on('error', (error) => {
  console.log('Güncelleme kontrolü hatası:', error);
});