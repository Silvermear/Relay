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

// Doğrulama bekleyen e-postayı geçici olarak tutuyoruz
let pendingVerificationEmail = null;

// Kayıt Ol işlemi
const registerBtn = document.getElementById('register-btn');
registerBtn.addEventListener('click', async () => {
  const username = document.getElementById('register-username').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const messageDiv = document.getElementById('register-message');

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!username || !email || !password) {
    messageDiv.textContent = 'Lütfen tüm alanları doldur.';
    messageDiv.classList.add('error');
    return;
  }

  // Kullanıcı adı benzersizlik kontrolü
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();

  if (existingProfile) {
    messageDiv.textContent = 'Bu kullanıcı adı zaten alınmış, başka bir tane dene.';
    messageDiv.classList.add('error');
    return;
  }

  // Kullanıcı adını geçici olarak auth metadata'sında saklıyoruz
  const { data, error } = await supabase.auth.signUp({
    email: email,
    password: password,
    options: {
      data: {
        username: username
      }
    }
  });

  if (error) {
    messageDiv.textContent = error.message;
    messageDiv.classList.add('error');
    return;
  }

  messageDiv.textContent = 'Kayıt başarılı! E-postanı kontrol et.';
  messageDiv.classList.add('success');

  // Doğrulama ekranına geç
  pendingVerificationEmail = email;

  formTabs.forEach(t => t.classList.remove('active'));
  formPanels.forEach(panel => panel.classList.remove('active'));
  document.getElementById('form-verify').classList.add('active');
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
    // E-posta doğrulanmamışsa, doğrulama ekranına yönlendir
    if (error.message.toLowerCase().includes('email not confirmed')) {
      messageDiv.textContent = 'E-postan henüz doğrulanmadı. Doğrulama kodunu gir.';
      messageDiv.classList.add('error');

      pendingVerificationEmail = email;

      formTabs.forEach(t => t.classList.remove('active'));
      formPanels.forEach(panel => panel.classList.remove('active'));
      document.getElementById('form-verify').classList.add('active');
      return;
    }

    messageDiv.textContent = error.message;
    messageDiv.classList.add('error');
  } else {
    messageDiv.textContent = 'Giriş başarılı!';
    messageDiv.classList.add('success');
    window.location.href = 'index.html';
  }
});

// Kod Doğrulama işlemi
const verifyBtn = document.getElementById('verify-btn');
verifyBtn.addEventListener('click', async () => {
  const code = document.getElementById('verify-code').value.trim();
  const messageDiv = document.getElementById('verify-message');

  messageDiv.textContent = '';
  messageDiv.className = 'message';

  if (!pendingVerificationEmail) {
    messageDiv.textContent = 'Önce kayıt ol veya giriş yapmayı dene.';
    messageDiv.classList.add('error');
    return;
  }

  if (!code || code.length !== 8) {
    messageDiv.textContent = 'Lütfen 8 haneli kodu gir.';
    messageDiv.classList.add('error');
    return;
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email: pendingVerificationEmail,
    token: code,
    type: 'signup'
  });

  if (error) {
    messageDiv.textContent = 'Kod hatalı veya süresi dolmuş: ' + error.message;
    messageDiv.classList.add('error');
    return;
  }

  // Doğrulama başarılı, şimdi profili oluşturalım (kullanıcı artık authenticated)
  if (data.user) {
    const username = data.user.user_metadata?.username;

    if (username) {
      // Profil zaten var mı kontrol et (mükerrer oluşturmayı önlemek için)
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', data.user.id)
        .maybeSingle();

      if (!existingProfile) {
        const { error: profileError } = await supabase
          .from('profiles')
          .insert({ id: data.user.id, username: username });

        if (profileError) {
          messageDiv.textContent = 'Doğrulandı ama profil oluşturulamadı: ' + profileError.message;
          messageDiv.classList.add('error');
          return;
        }
      }
    }
  }

  messageDiv.textContent = 'Doğrulama başarılı! Yönlendiriliyorsun...';
  messageDiv.classList.add('success');

  setTimeout(() => {
    window.location.href = 'welcome.html';
  }, 1000);
});