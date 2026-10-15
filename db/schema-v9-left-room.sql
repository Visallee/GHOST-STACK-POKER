-- ===========================================================
-- GhostStackPoker — schema-v9-left-room.sql
-- Fase 5: Proteção de integridade financeira (Soft Delete).
-- Roda em cima de tudo que já existe, sem apagar nada. 
-- Cole no SQL Editor do Supabase e clique em Run.
-- ===========================================================

-- Flag de "Fantasma". Se um jogador for expulso ou sair a meio de
-- uma mão com apostas ativas, ele não é apagado de imediato (o que
-- destruiria o dinheiro do pote). Ele é marcado como left_room, o
-- seu saldo vai a 0 e o fold é forçado. No final da mão, após a
-- entrega dos potes, o sistema limpa os fantasmas fisicamente.
alter table players add column if not exists left_room boolean not null default false;