// ===========================================================
// GhostStackPoker — js/session.js
// Como agora temos páginas separadas (home.html e partida.html), o
// navegador "esquece" as variáveis JavaScript ao trocar de página.
// Usamos sessionStorage (dura enquanto a aba estiver aberta) pra
// carregar código da sala, id do jogador etc. de uma página pra outra.
// ===========================================================

const SESSION_KEY = 'ghoststack_session';

// Chamado em home.js depois de criar/entrar numa sala com sucesso.
export function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

// Chamado em partida.js ao carregar a página.
// Retorna null se não houver nenhuma sessão salva (ex: o jogador
// abriu partida.html direto, sem passar pelo lobby).
export function loadSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}
