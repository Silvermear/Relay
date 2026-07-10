const supabase = require('./supabase.js');

// Sekmeler arası geçiş
const formTabs = document.querySelectorAll('.form-tab');
const formPanels = document.querySelectorAll('.form-panel');

formTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    formTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const target = tab.getAttribute('data-form');
    formPanels.forEach(panel => panel.classList.remove('active'));
    document.getElementById('form-' + target).classList.add('active');
  });
});

// Kayıt Ol işlemi
const registerBtn = document.getElementById('register-btn');
registerBtn.addEventListener('click', async () => {
  const username = document.getElementById('register-username').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;
  const messageDiv = document.getElementById('register-message');

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!username || !email || !password) {
    messageDiv.textContent = 'Lütfen tüm alanları doldur.';
    messageDiv.classList.add('error');
    return;
  }

  const { data, error } = await supabase.auth.signUp({
    email: email,
    password: password
  });

  if (error) {
    messageDiv.textContent = error.message;
    messageDiv.classList.add('error');
    return;
  }

  // Kullanıcı oluştuysa, profiles tablosuna kullanıcı adını kaydet
  if (data.user) {
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({ id: data.user.id, username: username });

    if (profileError) {
      messageDiv.textContent = 'Kayıt oldu ama profil oluşturulamadı: ' + profileError.message;
      messageDiv.classList.add('error');
      return;
    }
  }

  messageDiv.textContent = 'Kayıt başarılı! E-postanı kontrol et.';
  messageDiv.classList.add('success');
});

// Giriş Yap işlemi
const loginBtn = document.getElementById('login-btn');
loginBtn.addEventListener('click', async () => {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const messageDiv = document.getElementById('login-message');

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!email || !password) {
    messageDiv.textContent = 'Lütfen e-posta ve şifre gir.';
    messageDiv.classList.add('error');
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (error) {
    messageDiv.textContent = error.message;
    messageDiv.classList.add('error');
  } else {
    messageDiv.textContent = 'Giriş başarılı!';
    messageDiv.classList.add('success');
    window.location.href = 'index.html';
  }
});