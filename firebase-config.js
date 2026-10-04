// Configuração do projeto Firebase "orcamento-colaborativo".
// Estes valores não são senha: só identificam o projeto. A proteção dos dados vem do login + firestore.rules.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB9zmwvN9yRxGumobRVTc1unKoL-JQqAVM",
  authDomain: "orcamento-colaborativo.firebaseapp.com",
  projectId: "orcamento-colaborativo",
  storageBucket: "orcamento-colaborativo.firebasestorage.app",
  messagingSenderId: "322404803631",
  appId: "1:322404803631:web:fd2f5bf7655ffc082012da"
};

// Login com Google: desligado por padrão. No iPhone (app instalado na tela inicial) e em endereços
// do GitHub Pages ele costuma falhar; use e-mail e senha. Só ligue se publicar no Firebase Hosting.
window.ENABLE_GOOGLE_LOGIN = false;
