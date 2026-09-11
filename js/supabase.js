// ===========================================================
// GhostStackPoker — js/supabase.js
// Único lugar do projeto com as chaves de conexão com o banco.
// Qualquer outra página/arquivo que precisar falar com o Supabase
// deve importar o "supabaseClient" daqui — nunca criar outro cliente.
//
// Requer que o SDK do Supabase (via CDN) já tenha sido carregado
// ANTES deste arquivo, porque ele usa o objeto global "window.supabase".
// Veja a ordem correta dos <script> em pages/home.html e pages/partida.html.
// ===========================================================

const SUPABASE_URL = 'https://bmmlzdimagofulwqxapy.supabase.co';

// A "anon key" é segura para ficar aqui, mesmo em um repositório público.
// Ela só permite o que as políticas de Row Level Security (RLS) liberarem
// no banco — configuradas nas tabelas "rooms" e "players" (ver schema.sql).
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtbWx6ZGltYWdvZnVsd3F4YXB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwODc5MjUsImV4cCI6MjEwNDY2MzkyNX0.KEee9PUchfos1b5ROawgkTXcaTBNcKJ64w12_uPmIuc';

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
