// ===========================================================
// GhostStackPoker — js/room-code.js
// Gera códigos de sala de 6 caracteres. Usado tanto em home.js (ao
// criar uma sala) quanto em partida.js (quando o host clica em
// "Gerar Novo Código"). Fica num arquivo só pra não duplicar a lógica.
// ===========================================================

// Sem O/0/I/1 pra evitar confusão na hora de digitar.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return code;
}
