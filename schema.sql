-- ===========================================================
-- GhostStackPoker — Schema do banco (rodar no SQL Editor do Supabase)
-- ===========================================================

-- Tabela de salas
create table rooms (
  id text primary key,                         -- código da sala, ex: "A1B2C3"
  pot integer not null default 0,               -- valor total do pote
  ante_amount integer not null default 5,        -- valor do "pingo/ante"
  created_at timestamptz not null default now()
);

-- Tabela de jogadores
create table players (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references rooms(id) on delete cascade,
  name text not null,
  chips integer not null default 1000,          -- fichas que o jogador ainda tem
  current_bet integer not null default 0,       -- quanto apostou na rodada atual
  folded boolean not null default false,        -- se desistiu da rodada
  is_host boolean not null default false,       -- se foi quem criou a sala
  joined_at timestamptz not null default now()
);

-- Ativa Row Level Security (obrigatório para o Supabase liberar acesso)
alter table rooms enable row level security;
alter table players enable row level security;

-- Políticas simples: como é um app entre amigos (sem login), liberamos
-- leitura e escrita para qualquer pessoa que tenha a anon key (que já é
-- pública por natureza). Isso é seguro o suficiente para uma "vaquinha"
-- de poker entre amigos, mas não use esse modelo para dados sensíveis.
create policy "rooms_select" on rooms for select using (true);
create policy "rooms_insert" on rooms for insert with check (true);
create policy "rooms_update" on rooms for update using (true);

create policy "players_select" on players for select using (true);
create policy "players_insert" on players for insert with check (true);
create policy "players_update" on players for update using (true);
create policy "players_delete" on players for delete using (true);

-- Ativa o Realtime nas duas tabelas (assim as mudanças chegam pra todo mundo)
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table players;