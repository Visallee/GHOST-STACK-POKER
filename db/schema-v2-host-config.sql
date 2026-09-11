-- ===========================================================
-- GhostStackPoker — schema-v2-host-config.sql
-- Migração aditiva: roda em cima do schema.sql original, sem apagar
-- nada. Cole no SQL Editor do Supabase e clique em Run.
-- ===========================================================

-- ---------- Novas colunas na tabela "rooms" ----------

-- Estado da sala: 'configuring' enquanto o host ainda está na tela de
-- configuração, 'open' depois que ele clica em "Abrir Mesa". Jogadores
-- só conseguem entrar em salas 'open'.
alter table rooms add column if not exists status text not null default 'configuring';
alter table rooms add column if not exists host_id uuid references players(id);

-- Regras definidas pelo host na tela de configuração.
alter table rooms add column if not exists allow_kick boolean not null default true;
alter table rooms add column if not exists allow_donations boolean not null default false;
alter table rooms add column if not exists starting_chips integer not null default 1000;
alter table rooms add column if not exists max_players integer not null default 8;

-- Valor nominal e quantidade de cada cor de ficha (editável em "Configurações avançadas").
alter table rooms add column if not exists chip_values jsonb not null default
  '{"preta":5,"azul":10,"vermelha":20,"verde":50,"branca":100,"amarela":200}'::jsonb;
alter table rooms add column if not exists chip_counts jsonb not null default
  '{"preta":20,"azul":10,"vermelha":10,"verde":4,"branca":2,"amarela":1}'::jsonb;

-- Preparando o terreno pra Fase 4: controla se o botão "Cobrar Antes"
-- deve estar visível pro host (fica escondido depois de clicado, até
-- ele encerrar a rodada entregando o pote).
alter table rooms add column if not exists ante_collected boolean not null default false;

-- ---------- Observação sobre salas já existentes ----------
-- Salas criadas ANTES desta migração vão ficar com status = 'configuring'
-- (o valor padrão), então elas vão parecer "fechadas" pro comando de
-- entrar. Isso é esperado — são salas de teste antigas. Basta criar uma
-- sala nova pra testar o fluxo completo.
