-- =====================================================================
-- Wanted — schéma Supabase v0
-- À exécuter dans l'éditeur SQL du projet. Ré-exécutable : les tables
-- existantes sont conservées, les fonctions et règles sont remplacées.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
-- Notifications web : appel HTTP de la fonction d'envoi (pg_net) et tâche toutes les 10 s (pg_cron).
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.games (
  id int primary key default 1 check (id = 1),
  status text not null default 'accueil'
    check (status in ('accueil','dispersion','manche','regroupement','termine')),
  round int not null default 0 check (round between 0 and 2),
  dispersion_started_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  drawn_round int not null default 0,
  dispersion_minutes int not null default 10,
  round_minutes int not null default 60,
  immunity_seconds int not null default 120,
  org_code text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  pseudo text not null unique check (length(trim(pseudo)) between 1 and 30),
  access_code text not null unique,
  photo_path text,
  capture_code text not null check (capture_code ~ '^[0-9]{4}$'),
  immune_until timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Lien entre une session anonyme Supabase (un téléphone) et un joueur / l'organisateur.
create table if not exists public.devices (
  auth_uid uuid primary key,
  player_id uuid references public.players(id) on delete set null,
  is_organizer boolean not null default false,
  linked_at timestamptz not null default now()
);
create unique index if not exists devices_one_per_player
  on public.devices(player_id) where player_id is not null;

create table if not exists public.assignments (
  id bigint generated always as identity primary key,
  round int not null,
  hunter_id uuid not null references public.players(id) on delete cascade,
  target_id uuid not null references public.players(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text check (close_reason in ('capture','fin_manche','correction','reset'))
);
create unique index if not exists assignments_one_open_per_hunter
  on public.assignments(hunter_id) where closed_at is null;
create index if not exists assignments_open_target
  on public.assignments(target_id) where closed_at is null;

create table if not exists public.captures (
  id bigint generated always as identity primary key,
  round int not null,
  hunter_id uuid not null references public.players(id) on delete cascade,
  target_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  cancelled boolean not null default false
);

create table if not exists public.score_events (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  round int not null,
  points int not null,
  reason text not null,
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists score_events_player on public.score_events(player_id);

create table if not exists public.code_attempts (
  id bigint generated always as identity primary key,
  hunter_id uuid not null references public.players(id) on delete cascade,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists code_attempts_hunter on public.code_attempts(hunter_id, created_at);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  player_id uuid references public.players(id) on delete cascade, -- null = tout le monde
  body text not null check (length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create table if not exists public.event_log (
  id bigint generated always as identity primary key,
  kind text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- v1 : pings, positions, révélations, périmètre
alter table public.games add column if not exists perimeter jsonb;
alter table public.games add column if not exists ping_window_seconds int not null default 60;
alter table public.games add column if not exists missed_ping_penalty int not null default -3;
alter table public.games add column if not exists round_scored int not null default 0;

-- Un ping = une fenêtre pendant laquelle les joueurs concernés doivent envoyer leur position.
create table if not exists public.pings (
  id bigint generated always as identity primary key,
  round int not null,
  kind text not null check (kind in ('chasseur','general','manuel')),
  scheduled_at timestamptz not null,
  window_end timestamptz not null,
  player_id uuid references public.players(id) on delete cascade, -- ping manuel ciblé ; null = tous
  created_at timestamptz not null default now()
);
create index if not exists pings_round on public.pings(round, scheduled_at);

create table if not exists public.positions (
  id bigint generated always as identity primary key,
  ping_id bigint not null references public.pings(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  sent_at timestamptz not null default now(),
  out_of_perimeter boolean not null default false,
  distance_out_m double precision,
  unique (ping_id, player_id)
);
create index if not exists positions_player on public.positions(player_id, sent_at desc);

create table if not exists public.reveals (
  id bigint generated always as identity primary key,
  round int not null,
  player_id uuid not null references public.players(id) on delete cascade,
  scope text not null check (scope in ('chasseurs','tous')),
  created_at timestamptz not null default now()
);

-- v1.1 : repérage « Wanted ! » — le chasseur signale sa cible, puis a 1 min pour saisir le code.
alter table public.games add column if not exists challenge_seconds int not null default 60;
alter table public.games add column if not exists cooldown_seconds int not null default 120;
alter table public.players add column if not exists cooldown_until timestamptz;

create table if not exists public.challenges (
  id bigint generated always as identity primary key,
  round int not null,
  hunter_id uuid not null references public.players(id) on delete cascade,
  target_id uuid not null references public.players(id) on delete cascade,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active','reussi','echoue','annule')),
  wrong_attempts int not null default 0,
  resolved_at timestamptz
);
create unique index if not exists challenges_one_active_per_hunter
  on public.challenges(hunter_id) where status = 'active';
create unique index if not exists challenges_one_active_per_target
  on public.challenges(target_id) where status = 'active';

-- v3 : notifications web (Web Push)
-- Réglages privés : clés VAPID (créées par la fonction d'envoi), jeton et adresse de la fonction.
create table if not exists public.app_private_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Un abonnement par téléphone (un joueur peut en avoir plusieurs).
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_player on public.push_subscriptions(player_id);

-- File d'envoi : player_id vide = tous les joueurs actifs.
create table if not exists public.push_jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  round int,
  ref text,
  player_id uuid references public.players(id) on delete cascade,
  title text not null,
  body text not null,
  tag text,
  urgent boolean not null default false,
  send_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'attente'
    check (status in ('attente','envoi','envoye','annule','expire','echec')),
  attempts int not null default 0,
  locked_at timestamptz,
  sent_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists push_jobs_due on public.push_jobs(send_at) where status in ('attente','envoi');

-- v4 : nom réel, quêtes, chat
alter table public.players add column if not exists full_name text
  check (full_name is null or length(full_name) <= 80);
alter table public.games add column if not exists chat_enabled boolean not null default true;

-- Quêtes : player_id vide = pour tout le monde ; round vide = valable quelle que soit la manche.
create table if not exists public.quests (
  id bigint generated always as identity primary key,
  title text not null check (length(trim(title)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  points int not null default 1 check (points between -50 and 50),
  player_id uuid references public.players(id) on delete cascade,
  round int check (round is null or round between 1 and 2),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Le joueur déclare une quête faite ; l'organisation valide (points) ou refuse.
create table if not exists public.quest_claims (
  id bigint generated always as identity primary key,
  quest_id bigint not null references public.quests(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  note text check (note is null or length(note) <= 300),
  status text not null default 'en_attente' check (status in ('en_attente','validee','refusee')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (quest_id, player_id)
);

-- Chat général : player_id vide = message de l'organisation.
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  player_id uuid references public.players(id) on delete cascade,
  author_uid uuid not null,
  body text not null check (length(trim(body)) between 1 and 300),
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_recent on public.chat_messages(id desc);

-- v5 : messages privés (to_player / to_org), messages vocaux (media_path), photo de preuve des quêtes.
-- Public : to_player vide et to_org faux. Privé joueur → joueur : player_id → to_player.
-- Privé joueur → organisation : to_org vrai. Privé organisation → joueur : player_id vide, to_player rempli.
alter table public.chat_messages add column if not exists to_player uuid references public.players(id) on delete cascade;
alter table public.chat_messages add column if not exists to_org boolean not null default false;
alter table public.chat_messages add column if not exists media_path text;
alter table public.chat_messages add column if not exists media_seconds int
  check (media_seconds is null or media_seconds between 0 and 120);
alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check
  check (length(body) <= 300 and (length(trim(body)) >= 1 or media_path is not null));
create index if not exists chat_messages_to_player on public.chat_messages(to_player) where to_player is not null;
alter table public.games add column if not exists dm_enabled boolean not null default true;
alter table public.quests add column if not exists photo_required boolean not null default false;
alter table public.quest_claims add column if not exists photo_path text;

-- Dernier message lu par conversation (viewer = id du joueur ou 'org' ; conv = 'all', 'org' ou id d'un joueur).
create table if not exists public.chat_reads (
  viewer text not null,
  conv text not null,
  last_id bigint not null default 0,
  primary key (viewer, conv)
);

-- Aucun accès direct aux tables depuis le front : tout passe par les fonctions.
do $$
declare t text;
begin
  foreach t in array array['games','players','devices','assignments','captures',
                           'score_events','code_attempts','messages','event_log',
                           'pings','positions','reveals','challenges',
                           'app_private_config','push_subscriptions','push_jobs',
                           'quests','quest_claims','chat_messages','chat_reads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Fonctions internes (non appelables depuis le front)
-- ---------------------------------------------------------------------

create or replace function public._random_code(p_len int, p_alphabet text)
returns text language plpgsql volatile
set search_path = public, extensions
as $$
declare
  v_bytes bytea := gen_random_bytes(p_len);
  v_out text := '';
  i int;
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(p_alphabet, 1 + (get_byte(v_bytes, i) % length(p_alphabet)), 1);
  end loop;
  return v_out;
end $$;

create or replace function public._new_capture_code(p_old text default null)
returns text language plpgsql volatile
set search_path = public, extensions
as $$
declare v text;
begin
  loop
    v := public._random_code(4, '0123456789');
    exit when p_old is null or v <> p_old;
  end loop;
  return v;
end $$;

create or replace function public._new_access_code()
returns text language plpgsql volatile
set search_path = public, extensions
as $$
declare v text;
begin
  loop
    -- 6 caractères sans I, L, O, 0 ni 1 pour éviter les confusions.
    v := public._random_code(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    exit when not exists (select 1 from public.players where access_code = v);
  end loop;
  return v;
end $$;

create or replace function public._my_player_id()
returns uuid language sql stable security definer
set search_path = public
as $$ select player_id from public.devices where auth_uid = auth.uid() $$;

create or replace function public._is_org()
returns boolean language sql stable security definer
set search_path = public
as $$ select coalesce((select is_organizer from public.devices where auth_uid = auth.uid()), false) $$;

create or replace function public._has_device()
returns boolean language sql stable security definer
set search_path = public
as $$ select exists (select 1 from public.devices
                     where auth_uid = auth.uid() and (player_id is not null or is_organizer)) $$;

create or replace function public._require_org()
returns void language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public._is_org() then
    raise exception 'Accès organisateur requis';
  end if;
end $$;

create or replace function public._log(p_kind text, p_detail jsonb default null)
returns void language sql security definer
set search_path = public
as $$ insert into public.event_log(kind, detail) values (p_kind, p_detail) $$;

-- Réveille la fonction d'envoi des notifications (une fois par transaction au plus).
-- Ne bloque jamais le jeu : toute erreur est ignorée, la tâche des 10 s rattrapera.
create or replace function public._push_kick()
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare v_url text; v_token text;
begin
  if coalesce(current_setting('wanted.push_kicked', true), '') = '1' then return; end if;
  if not exists (select 1 from public.push_jobs
                  where send_at <= now() and (status = 'attente'
                        or (status = 'envoi' and locked_at < now() - interval '2 minutes'))) then
    return;
  end if;
  select value into v_url from public.app_private_config where key = 'push_dispatch_url';
  select value into v_token from public.app_private_config where key = 'push_dispatch_token';
  if v_url is null or v_token is null then return; end if;
  perform set_config('wanted.push_kicked', '1', true);
  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-token', v_token),
      body := '{}'::jsonb,
      timeout_milliseconds := 8000);
  exception when others then
    null;
  end;
end $$;

-- Met une notification en file. p_player null = tous les joueurs actifs.
create or replace function public._push(p_player uuid, p_kind text, p_title text, p_body text,
                                        p_tag text default null, p_urgent boolean default false,
                                        p_send_at timestamptz default now(),
                                        p_expires_at timestamptz default null,
                                        p_round int default null, p_ref text default null)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  insert into public.push_jobs(kind, round, ref, player_id, title, body, tag, urgent, send_at, expires_at)
  values (p_kind, p_round, p_ref, p_player, p_title, p_body, p_tag, p_urgent, p_send_at,
          coalesce(p_expires_at, p_send_at + interval '15 minutes'));
  if p_send_at <= now() then
    perform public._push_kick();
  end if;
end $$;

-- Cible au hasard : ni le chasseur, ni la cible qu'il vient de quitter (si possible).
create or replace function public._pick_target(p_hunter uuid, p_exclude uuid)
returns uuid language plpgsql volatile security definer
set search_path = public
as $$
declare v uuid;
begin
  select id into v from public.players
   where active and id <> p_hunter and id <> coalesce(p_exclude, p_hunter)
   order by random() limit 1;
  if v is null then
    select id into v from public.players
     where active and id <> p_hunter
     order by random() limit 1;
  end if;
  return v;
end $$;

-- Tirage de départ en boucle : chacun chasse le suivant, tout le monde a un chasseur.
create or replace function public._draw(p_round int)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  n int;
  i int;
begin
  update public.assignments set closed_at = now(), close_reason = 'correction'
   where closed_at is null;

  select array_agg(id order by random()) into v_ids from public.players where active;
  n := coalesce(array_length(v_ids, 1), 0);

  if n < 2 then
    perform public._log('tirage_impossible', jsonb_build_object('manche', p_round, 'joueurs', n));
    return;
  end if;

  for i in 1 .. n loop
    insert into public.assignments(round, hunter_id, target_id)
    values (p_round, v_ids[i], v_ids[(i % n) + 1]);
  end loop;

  perform public._log('tirage', jsonb_build_object('manche', p_round, 'joueurs', n));
end $$;

-- Pings de la manche, calculés depuis le START : chasseurs à +15, +30, +45 ; général à +40.
create or replace function public._schedule_pings(p_round int, p_start timestamptz, p_window int)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  delete from public.pings where round = p_round;
  delete from public.reveals where round = p_round;
  delete from public.push_jobs where kind = 'ping' and round = p_round and status = 'attente';
  insert into public.pings(round, kind, scheduled_at, window_end)
  select p_round, k.kind, p_start + make_interval(mins => k.m),
         p_start + make_interval(mins => k.m, secs => p_window)
    from (values (15, 'chasseur'), (30, 'chasseur'), (40, 'general'), (45, 'chasseur')) as k(m, kind);

  -- Notifications : 1 min avant (le temps d'ouvrir l'appli et de chauffer le GPS), puis à l'heure.
  insert into public.push_jobs(kind, round, ref, title, body, tag, urgent, send_at, expires_at)
  select 'ping', p_round, pg.id::text,
         case when pg.kind = 'general' then 'Ping général dans 1 min' else 'Ping dans 1 min' end,
         'Ouvre Wanted maintenant : tu auras 1 minute pour envoyer ta position.',
         'ping-' || pg.id, false, pg.scheduled_at - interval '60 seconds', pg.scheduled_at
    from public.pings pg where pg.round = p_round and pg.kind in ('chasseur', 'general')
  union all
  select 'ping', p_round, pg.id::text,
         case when pg.kind = 'general' then 'PING GÉNÉRAL : envoie ta position' else 'PING : envoie ta position' end,
         'Tu as 1 minute. Ping manqué = −3 points.',
         'ping-' || pg.id, true, pg.scheduled_at, pg.window_end
    from public.pings pg where pg.round = p_round and pg.kind in ('chasseur', 'general');
end $$;

-- Fin de manche : −3 par ping manqué, +1 de bonus survivant.
create or replace function public._score_round(p_round int)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  select * into g from public.games where id = 1;

  -- Pings manqués (seulement les fenêtres déjà terminées).
  insert into public.score_events(player_id, round, points, reason, ref)
  select p.id, p_round, g.missed_ping_penalty, 'ping manqué', pg.id::text
    from public.pings pg
    join public.players p on p.active and (pg.player_id is null or pg.player_id = p.id)
   where pg.round = p_round
     and pg.window_end <= now()
     and p.created_at < pg.scheduled_at
     and not exists (select 1 from public.positions po where po.ping_id = pg.id and po.player_id = p.id)
     and not exists (select 1 from public.score_events s
                      where s.player_id = p.id and s.reason = 'ping manqué' and s.ref = pg.id::text);

  -- Bonus survivant : à un ping chasseur, au moins 2 chasseurs et pas trouvé depuis le ping chasseur précédent.
  insert into public.score_events(player_id, round, points, reason, ref)
  select p.id, p_round, 1, 'bonus survivant', pg.id::text
    from public.pings pg
    join public.players p on p.active
   where pg.round = p_round and pg.kind = 'chasseur' and pg.scheduled_at <= now()
     and (select count(*) from public.assignments a
           where a.target_id = p.id and a.round = p_round
             and a.assigned_at <= pg.scheduled_at
             and (a.closed_at is null or a.closed_at > pg.scheduled_at)) >= 2
     and not exists (
       select 1 from public.captures c
        where c.target_id = p.id and c.round = p_round and not c.cancelled
          and c.created_at <= pg.scheduled_at
          and c.created_at > coalesce(
                (select max(pp.scheduled_at) from public.pings pp
                  where pp.round = p_round and pp.kind = 'chasseur' and pp.scheduled_at < pg.scheduled_at),
                g.start_at))
     and not exists (select 1 from public.score_events s
                      where s.player_id = p.id and s.reason = 'bonus survivant' and s.ref = pg.id::text);

  perform public._log('score_manche', jsonb_build_object('manche', p_round));
end $$;

-- Position dans le périmètre ? Distance au bord en mètres (projection locale, suffisante à l'échelle d'une ville).
create or replace function public._perimeter_check(p_lat double precision, p_lng double precision,
                                                   out inside boolean, out dist_m double precision)
language plpgsql stable security definer
set search_path = public
as $$
declare
  ring jsonb;
  n int; i int; j int;
  kx double precision := 111320 * cos(radians(p_lat));
  ky double precision := 110540;
  x1 double precision; y1 double precision; x2 double precision; y2 double precision;
  dx double precision; dy double precision; t double precision; d double precision;
begin
  select perimeter -> 'geometry' -> 'coordinates' -> 0 into ring from public.games where id = 1;
  if ring is null or jsonb_array_length(ring) < 3 then
    inside := true; dist_m := 0; return;
  end if;
  n := jsonb_array_length(ring);
  inside := false;
  dist_m := 'infinity';
  for i in 0 .. n - 1 loop
    j := (i + 1) % n;
    x1 := ((ring -> i ->> 0)::float8 - p_lng) * kx;  y1 := ((ring -> i ->> 1)::float8 - p_lat) * ky;
    x2 := ((ring -> j ->> 0)::float8 - p_lng) * kx;  y2 := ((ring -> j ->> 1)::float8 - p_lat) * ky;
    if (y1 > 0) <> (y2 > 0) and (x1 - y1 * (x2 - x1) / (y2 - y1)) > 0 then
      inside := not inside;
    end if;
    dx := x2 - x1; dy := y2 - y1;
    t := case when dx = 0 and dy = 0 then 0
              else greatest(0, least(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) end;
    d := sqrt((x1 + t * dx) ^ 2 + (y1 + t * dy) ^ 2);
    if d < dist_m then dist_m := d; end if;
  end loop;
end $$;

-- Dernière position visible d'un joueur pour ses chasseurs (pings chasseur/général ou révélation).
create or replace function public._hunter_view(p_player uuid, p_round int)
returns json language sql stable security definer
set search_path = public
as $$
  select json_build_object('lat', po.lat, 'lng', po.lng, 'accuracy', po.accuracy, 'sent_at', po.sent_at)
    from public.positions po join public.pings pg on pg.id = po.ping_id
   where po.player_id = p_player and pg.round = p_round
     and (pg.kind in ('chasseur', 'general')
          or exists (select 1 from public.reveals r
                      where r.player_id = p_player and r.round = p_round and r.created_at >= po.sent_at))
   order by po.sent_at desc limit 1
$$;

-- Fait avancer la partie selon l'heure du serveur (tirage, fin de manche).
-- Appelée par toutes les fonctions publiques : pas besoin de tâche planifiée.
create or replace function public._tick()
returns public.games language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  select * into g from public.games where id = 1;
  if g.id is null then
    raise exception 'Partie non initialisée';
  end if;

  perform public._expire_challenges();

  if (g.status = 'dispersion' and now() >= g.start_at)
     or (g.status = 'manche' and now() >= g.end_at) then
    select * into g from public.games where id = 1 for update;

    if g.status = 'dispersion' and now() >= g.start_at then
      if g.drawn_round < g.round then
        perform public._draw(g.round);
        perform public._schedule_pings(g.round, g.start_at, g.ping_window_seconds);
      end if;
      update public.games
         set status = 'manche', drawn_round = g.round, updated_at = now()
       where id = 1 returning * into g;
      perform public._log('debut_manche', jsonb_build_object('manche', g.round));
      perform public._push(null, 'start', 'START ! Manche ' || g.round,
        'Ta cible est tirée. Ouvre Wanted pour la découvrir.', 'start', true,
        now(), g.start_at + interval '5 minutes', g.round);
    end if;

    if g.status = 'manche' and now() >= g.end_at then
      if g.round_scored < g.round then
        perform public._score_round(g.round);
        update public.games set round_scored = g.round where id = 1;
      end if;
      update public.assignments set closed_at = now(), close_reason = 'fin_manche'
       where closed_at is null;
      update public.challenges set status = 'annule', resolved_at = now() where status = 'active';
      update public.games set status = 'regroupement', updated_at = now()
       where id = 1 returning * into g;
      perform public._log('fin_manche', jsonb_build_object('manche', g.round));
      update public.push_jobs set status = 'annule'
       where status = 'attente' and kind = 'ping' and round = g.round;
      perform public._push(null, 'fin', 'Fin de la manche ' || g.round,
        'Rendez-vous au point de regroupement.', 'fin', true, now(), now() + interval '15 minutes', g.round);
    end if;
  end if;

  return g;
end $$;

-- Bouton « Wanted ! » bloqué jusqu'à cette heure (après un repérage raté).
create or replace function public._lock_info(p_player uuid)
returns timestamptz language sql stable security definer
set search_path = public
as $$ select cooldown_until from public.players where id = p_player and cooldown_until > now() $$;

-- Repérage raté : la cible est immunisée 2 min, le chasseur ne peut plus repérer pendant 2 min.
create or replace function public._fail_challenge(p_id bigint, p_at timestamptz)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare
  c public.challenges;
  g public.games;
begin
  select * into g from public.games where id = 1;
  update public.challenges set status = 'echoue', resolved_at = now()
   where id = p_id and status = 'active' returning * into c;
  if c.id is null then return; end if;
  update public.players
     set immune_until = greatest(coalesce(immune_until, '-infinity'), p_at + make_interval(secs => g.immunity_seconds))
   where id = c.target_id;
  update public.players
     set cooldown_until = greatest(coalesce(cooldown_until, '-infinity'), p_at + make_interval(secs => g.cooldown_seconds))
   where id = c.hunter_id;
  perform public._log('repere_echoue', jsonb_build_object(
    'chasseur', (select pseudo from public.players where id = c.hunter_id),
    'cible', (select pseudo from public.players where id = c.target_id)));
  perform public._push(c.target_id, 'repere_echoue', 'Fausse alerte : tu peux repartir',
    'Le chasseur n''a pas eu ton code à temps. Tu es immunisé 2 min.', 'repere', false,
    now(), now() + make_interval(secs => g.immunity_seconds), c.round);
end $$;

-- Repérages dont la minute est écoulée (+5 s de marge réseau).
create or replace function public._expire_challenges()
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare c record;
begin
  for c in select id, expires_at from public.challenges
            where status = 'active' and expires_at + interval '5 seconds' < now()
            for update skip locked loop
    perform public._fail_challenge(c.id, c.expires_at);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Fonctions joueur
-- ---------------------------------------------------------------------

create or replace function public.claim_player(p_code text)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  p public.players;
begin
  if v_uid is null then raise exception 'Session requise'; end if;

  select * into p from public.players
   where access_code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if p.id is null then raise exception 'Code invalide'; end if;
  if not p.active then raise exception 'Joueur désactivé'; end if;

  -- Le code fonctionne sur un nouveau téléphone : l'ancien est délié.
  update public.devices set player_id = null where player_id = p.id and auth_uid <> v_uid;
  insert into public.devices(auth_uid, player_id) values (v_uid, p.id)
  on conflict (auth_uid) do update set player_id = excluded.player_id, linked_at = now();

  perform public._log('connexion', jsonb_build_object('joueur', p.pseudo));
  return json_build_object('pseudo', p.pseudo);
end $$;

create or replace function public.get_my_state()
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  g public.games;
  v_me uuid := public._my_player_id();
  p public.players;
  v_me_json json;
  v_target json;
begin
  if auth.uid() is null then raise exception 'Session requise'; end if;
  g := public._tick();

  if v_me is not null then
    select * into p from public.players where id = v_me;
    v_me_json := json_build_object(
      'id', p.id,
      'pseudo', p.pseudo,
      'photo_path', p.photo_path,
      'capture_code', p.capture_code,
      'immune_until', p.immune_until,
      'score_total', (select coalesce(sum(points), 0) from public.score_events where player_id = p.id),
      'score_round', (select coalesce(sum(points), 0) from public.score_events
                       where player_id = p.id and round = g.round),
      'captures_round', (select count(*) from public.captures
                          where hunter_id = p.id and round = g.round and not cancelled),
      'locked_until', public._lock_info(p.id),
      'push_devices', (select count(*) from public.push_subscriptions s where s.player_id = p.id),
      -- Nombre de chasseurs à ses trousses (sans leur nom).
      'hunters', case when g.status = 'manche' then
                   (select count(*) from public.assignments a
                     where a.target_id = p.id and a.closed_at is null and a.round = g.round)
                 else 0 end
    );

    if g.status = 'manche' and now() < g.end_at then
      select json_build_object('pseudo', t.pseudo, 'photo_path', t.photo_path, 'assigned_at', a.assigned_at,
                               'immune_until', case when t.immune_until > now() then t.immune_until end,
                               'position', public._hunter_view(t.id, g.round))
        into v_target
        from public.assignments a join public.players t on t.id = a.target_id
       where a.hunter_id = p.id and a.closed_at is null;
    end if;
  end if;

  return json_build_object(
    'server_now', now(),
    'is_organizer', public._is_org(),
    'game', json_build_object(
      'status', g.status, 'round', g.round,
      'dispersion_started_at', g.dispersion_started_at,
      'start_at', g.start_at, 'end_at', g.end_at,
      'immunity_seconds', g.immunity_seconds),
    'me', v_me_json,
    'target', v_target,
    -- Mon repérage en cours (en tant que chasseur).
    'spot', (
      select json_build_object('expires_at', c.expires_at, 'wrong_attempts', c.wrong_attempts)
        from public.challenges c where c.hunter_id = v_me and c.status = 'active'),
    -- Je suis repéré : je dois m'arrêter (le chasseur n'est pas nommé).
    'spotted', (
      select json_build_object('id', c.id, 'expires_at', c.expires_at)
        from public.challenges c where c.target_id = v_me and c.status = 'active'),
    -- Mes pings de la manche (le front calcule le prochain et la fenêtre ouverte).
    'pings', (
      select coalesce(json_agg(json_build_object(
               'id', pg.id, 'kind', pg.kind, 'scheduled_at', pg.scheduled_at, 'window_end', pg.window_end,
               'sent', exists (select 1 from public.positions po where po.ping_id = pg.id and po.player_id = v_me))
             order by pg.scheduled_at), '[]'::json)
        from public.pings pg
       where v_me is not null and pg.round = g.round and g.status = 'manche'
         and (pg.player_id is null or pg.player_id = v_me)),
    -- Positions visibles de tous : ping général (ou « ping tous » de l'organisation) le plus récent
    -- + révélations « à tous ».
    'public_positions', (
      select coalesce(json_agg(x), '[]'::json) from (
        select pl.pseudo, po.lat, po.lng, po.sent_at, 'general' as source
          from public.positions po
          join public.players pl on pl.id = po.player_id
         where v_me is not null and g.status = 'manche'
           and po.ping_id = (select id from public.pings
                              where round = g.round and scheduled_at <= now()
                                and (kind = 'general' or (kind = 'manuel' and player_id is null))
                              order by scheduled_at desc, id desc limit 1)
        union all
        select pl.pseudo, lp.lat, lp.lng, lp.sent_at, 'revelation'
          from public.reveals r
          join public.players pl on pl.id = r.player_id
          cross join lateral (select po.lat, po.lng, po.sent_at from public.positions po
                               where po.player_id = r.player_id and po.sent_at <= r.created_at
                               order by po.sent_at desc limit 1) lp
         where v_me is not null and g.status = 'manche' and r.round = g.round and r.scope = 'tous') x),
    'my_position', (
      select json_build_object('lat', po.lat, 'lng', po.lng, 'sent_at', po.sent_at, 'out', po.out_of_perimeter)
        from public.positions po join public.pings pg on pg.id = po.ping_id
       where po.player_id = v_me and pg.round = g.round
       order by po.sent_at desc limit 1),
    'messages', (
      select coalesce(json_agg(m order by m.created_at desc), '[]'::json)
        from (select id, body, created_at, (player_id is not null) as private
                from public.messages
               where v_me is not null and (player_id is null or player_id = v_me)
               order by created_at desc limit 20) m),
    'chat', json_build_object(
      'enabled', g.chat_enabled,
      'dm_enabled', g.dm_enabled,
      'unread', case when v_me is null then '{}'::text[] else public._chat_unread(v_me, false) end),
    'quests', json_build_object(
      'todo', (select count(*) from public.quests q
                where v_me is not null and q.active
                  and (q.player_id is null or q.player_id = v_me)
                  and (q.round is null or q.round = g.round)
                  and not exists (select 1 from public.quest_claims c
                                   where c.quest_id = q.id and c.player_id = v_me and c.status <> 'refusee')),
      'last_id', (select max(q.id) from public.quests q
                   where v_me is not null and q.active and (q.player_id is null or q.player_id = v_me)))
  );
end $$;

-- « Wanted ! » : le chasseur pense avoir trouvé sa cible. La cible est prévenue et doit s'arrêter ;
-- le chasseur a 1 min pour la rejoindre et saisir son code.
create or replace function public.spot_target()
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me uuid := public._my_player_id();
  g public.games;
  a public.assignments;
  me public.players;
  t public.players;
  c public.challenges;
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  g := public._tick();
  if g.status <> 'manche' or now() < g.start_at or now() >= g.end_at then
    return json_build_object('ok', false, 'reason', 'not_running');
  end if;

  select * into a from public.assignments
   where hunter_id = v_me and closed_at is null and round = g.round;
  if a.id is null then
    return json_build_object('ok', false, 'reason', 'no_target');
  end if;

  perform 1 from public.players where id in (v_me, a.target_id) order by id for update;
  if not exists (select 1 from public.assignments where id = a.id and closed_at is null) then
    return json_build_object('ok', false, 'reason', 'target_changed');
  end if;
  select * into me from public.players where id = v_me;
  select * into t from public.players where id = a.target_id;

  select * into c from public.challenges where hunter_id = v_me and status = 'active';
  if c.id is not null then
    if c.target_id = t.id then
      return json_build_object('ok', true, 'already', true, 'expires_at', c.expires_at);
    end if;
    update public.challenges set status = 'annule', resolved_at = now() where id = c.id;
  end if;

  if me.cooldown_until > now() then
    return json_build_object('ok', false, 'reason', 'cooldown', 'locked_until', me.cooldown_until);
  end if;
  if t.immune_until > now() then
    return json_build_object('ok', false, 'reason', 'immune', 'immune_until', t.immune_until);
  end if;
  if exists (select 1 from public.challenges where target_id = t.id and status = 'active') then
    return json_build_object('ok', false, 'reason', 'already_spotted');
  end if;

  insert into public.challenges(round, hunter_id, target_id, expires_at)
  values (g.round, v_me, t.id, now() + make_interval(secs => g.challenge_seconds))
  returning * into c;

  perform public._log('repere', jsonb_build_object('chasseur', me.pseudo, 'cible', t.pseudo));
  perform public._push(t.id, 'repere', 'WANTED ! Tu es repéré, arrête-toi',
    'Un chasseur arrive. Donne-lui ton code : ' || t.capture_code || '. Il a 1 minute.', 'repere', true,
    now(), c.expires_at, g.round, c.id::text);
  return json_build_object('ok', true, 'expires_at', c.expires_at);
end $$;

create or replace function public.submit_capture(p_code text)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me uuid := public._my_player_id();
  g public.games;
  a public.assignments;
  t public.players;
  c public.challenges;
  v_fail int;
  v_capture_id bigint;
  v_hunters uuid[];
  v_h uuid;
  v_new_target text;
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  g := public._tick();
  if g.status <> 'manche' or now() < g.start_at or now() >= g.end_at then
    return json_build_object('ok', false, 'reason', 'not_running');
  end if;

  select * into a from public.assignments
   where hunter_id = v_me and closed_at is null and round = g.round;
  if a.id is null then
    return json_build_object('ok', false, 'reason', 'no_target');
  end if;

  -- Verrou du chasseur et de la cible, dans un ordre fixe (évite les doubles envois et les blocages).
  perform 1 from public.players where id in (v_me, a.target_id) order by id for update;
  if not exists (select 1 from public.assignments where id = a.id and closed_at is null) then
    return json_build_object('ok', false, 'reason', 'target_changed');
  end if;

  -- Le code ne peut être saisi que pendant la minute qui suit « Wanted ! ».
  select * into c from public.challenges
   where hunter_id = v_me and target_id = a.target_id and status = 'active';
  if c.id is null then
    return json_build_object('ok', false, 'reason', 'no_spot', 'locked_until', public._lock_info(v_me));
  end if;
  if now() > c.expires_at + interval '5 seconds' then
    perform public._fail_challenge(c.id, c.expires_at);
    return json_build_object('ok', false, 'reason', 'expired', 'locked_until', public._lock_info(v_me));
  end if;

  select * into t from public.players where id = a.target_id;

  if regexp_replace(coalesce(p_code, ''), '\D', '', 'g') <> t.capture_code then
    insert into public.code_attempts(hunter_id, success) values (v_me, false);
    update public.challenges set wrong_attempts = wrong_attempts + 1 where id = c.id
    returning wrong_attempts into v_fail;
    if v_fail >= 3 then
      perform public._fail_challenge(c.id, now());
      return json_build_object('ok', false, 'reason', 'failed', 'locked_until', public._lock_info(v_me));
    end if;
    return json_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 3 - v_fail);
  end if;

  update public.challenges set status = 'reussi', resolved_at = now() where id = c.id;
  insert into public.code_attempts(hunter_id, success) values (v_me, true);
  insert into public.captures(round, hunter_id, target_id)
  values (g.round, v_me, t.id) returning id into v_capture_id;
  insert into public.score_events(player_id, round, points, reason, ref) values
    (v_me, g.round, 3, 'capture', v_capture_id::text),
    (t.id, g.round, -2, 'capturé', v_capture_id::text);

  update public.players
     set capture_code = public._new_capture_code(t.capture_code),
         immune_until = now() + make_interval(secs => g.immunity_seconds)
   where id = t.id;

  -- Tous les chasseurs de cette cible reçoivent une nouvelle cible au hasard.
  with closed as (
    update public.assignments set closed_at = now(), close_reason = 'capture'
     where target_id = t.id and closed_at is null
    returning hunter_id)
  select array_agg(hunter_id) into v_hunters from closed;

  foreach v_h in array coalesce(v_hunters, '{}'::uuid[]) loop
    insert into public.assignments(round, hunter_id, target_id)
    values (g.round, v_h, public._pick_target(v_h, t.id));
    if v_h <> v_me then
      perform public._push(v_h, 'nouvelle_cible', 'Nouvelle cible',
        'Ta cible a été capturée par un autre chasseur. Ouvre Wanted pour voir la nouvelle.',
        'cible', false, now(), now() + interval '10 minutes', g.round);
    end if;
  end loop;

  perform public._log('capture', jsonb_build_object(
    'manche', g.round, 'chasseur', (select pseudo from public.players where id = v_me),
    'cible', t.pseudo, 'chasseurs_reattribues', coalesce(array_length(v_hunters, 1), 0)));

  select tp.pseudo into v_new_target
    from public.assignments na join public.players tp on tp.id = na.target_id
   where na.hunter_id = v_me and na.closed_at is null;

  return json_build_object('ok', true, 'captured', t.pseudo, 'new_target', v_new_target);
end $$;

-- Envoi de position : enregistrée pour chaque fenêtre de ping ouverte qui concerne le joueur.
create or replace function public.send_position(p_lat double precision, p_lng double precision,
                                                p_accuracy double precision default null)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me uuid := public._my_player_id();
  g public.games;
  v_inside boolean;
  v_dist double precision;
  v_out boolean;
  v_count int;
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Position invalide';
  end if;
  g := public._tick();
  if g.status <> 'manche' then
    return json_build_object('ok', false, 'reason', 'not_running');
  end if;

  select c.inside, c.dist_m into v_inside, v_dist from public._perimeter_check(p_lat, p_lng) c;
  -- Hors périmètre seulement si la position reste dehors même en tenant compte de la précision GPS.
  v_out := not v_inside and v_dist > coalesce(p_accuracy, 0);

  insert into public.positions(ping_id, player_id, lat, lng, accuracy, out_of_perimeter, distance_out_m)
  select pg.id, v_me, p_lat, p_lng, p_accuracy, v_out, case when v_inside then 0 else round(v_dist::numeric, 1) end
    from public.pings pg
   where pg.round = g.round
     and now() >= pg.scheduled_at
     and now() <= pg.window_end + interval '10 seconds' -- marge réseau
     and (pg.player_id is null or pg.player_id = v_me)
  on conflict (ping_id, player_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    if exists (select 1 from public.pings pg join public.positions po on po.ping_id = pg.id and po.player_id = v_me
                where pg.round = g.round and now() between pg.scheduled_at and pg.window_end + interval '10 seconds') then
      return json_build_object('ok', true, 'already', true);
    end if;
    return json_build_object('ok', false, 'reason', 'no_window');
  end if;

  if v_out then
    perform public._log('hors_perimetre', jsonb_build_object(
      'joueur', (select pseudo from public.players where id = v_me), 'distance_m', round(v_dist)));
  end if;
  return json_build_object('ok', true, 'out_of_perimeter', v_out,
                           'distance_m', case when v_inside then 0 else round(v_dist) end);
end $$;

create or replace function public.get_perimeter()
returns jsonb language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public._has_device() then raise exception 'Session requise'; end if;
  return (select perimeter from public.games where id = 1);
end $$;

create or replace function public.get_leaderboard()
returns json language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public._has_device() then raise exception 'Session requise'; end if;
  return (
    select coalesce(json_agg(x order by x.total desc, x.pseudo), '[]'::json)
      from (select p.pseudo,
                   coalesce(sum(s.points), 0) as total,
                   coalesce(sum(s.points) filter (where s.round = 1), 0) as round1,
                   coalesce(sum(s.points) filter (where s.round = 2), 0) as round2,
                   (select count(*) from public.captures c
                     where c.hunter_id = p.id and not c.cancelled) as captures
              from public.players p
              left join public.score_events s on s.player_id = p.id
             where p.active
             group by p.id, p.pseudo) x);
end $$;

-- ---------------------------------------------------------------------
-- Fonctions organisateur
-- ---------------------------------------------------------------------

create or replace function public.claim_organizer(p_code text)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Session requise'; end if;
  if not exists (select 1 from public.games
                  where id = 1 and org_code = upper(trim(coalesce(p_code, '')))) then
    raise exception 'Code organisateur invalide';
  end if;
  insert into public.devices(auth_uid, is_organizer) values (v_uid, true)
  on conflict (auth_uid) do update set is_organizer = true, linked_at = now();
  perform public._log('connexion_organisateur', null);
  return json_build_object('ok', true);
end $$;

create or replace function public.org_get_overview()
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  perform public._require_org();
  g := public._tick();
  return json_build_object(
    'server_now', now(),
    'game', json_build_object(
      'status', g.status, 'round', g.round,
      'dispersion_started_at', g.dispersion_started_at,
      'start_at', g.start_at, 'end_at', g.end_at,
      'dispersion_minutes', g.dispersion_minutes, 'round_minutes', g.round_minutes),
    'players', (
      select coalesce(json_agg(x order by x.pseudo), '[]'::json) from (
        select p.id, p.pseudo, p.full_name, p.access_code, p.photo_path, p.capture_code, p.immune_until, p.active,
               exists (select 1 from public.devices d where d.player_id = p.id) as linked,
               (select count(*) from public.push_subscriptions s where s.player_id = p.id) as push_devices,
               (select coalesce(sum(points), 0) from public.score_events s where s.player_id = p.id) as score_total,
               (select coalesce(sum(points), 0) from public.score_events s
                 where s.player_id = p.id and s.round = g.round) as score_round,
               (select t.pseudo from public.assignments a join public.players t on t.id = a.target_id
                 where a.hunter_id = p.id and a.closed_at is null) as target,
               (select count(*) from public.assignments a
                 where a.target_id = p.id and a.closed_at is null) as hunters,
               exists (select 1 from public.challenges ch
                        where ch.target_id = p.id and ch.status = 'active') as spotted,
               case when p.cooldown_until > now() then p.cooldown_until end as cooldown_until,
               (select json_build_object('lat', po.lat, 'lng', po.lng, 'accuracy', po.accuracy,
                                         'sent_at', po.sent_at, 'out', po.out_of_perimeter,
                                         'distance_out_m', po.distance_out_m)
                  from public.positions po where po.player_id = p.id
                 order by po.sent_at desc limit 1) as last_position,
               (select count(*) from public.positions po join public.pings pg on pg.id = po.ping_id
                 where po.player_id = p.id and pg.round = g.round and po.out_of_perimeter) as out_count
          from public.players p) x),
    'pings', (
      select coalesce(json_agg(x order by x.scheduled_at), '[]'::json) from (
        select pg.id, pg.kind, pg.scheduled_at, pg.window_end,
               (select pseudo from public.players where id = pg.player_id) as for_player,
               (select count(*) from public.positions po where po.ping_id = pg.id) as sent,
               (select count(*) from public.players p
                 where p.active and (pg.player_id is null or pg.player_id = p.id)) as expected
          from public.pings pg where pg.round = g.round) x),
    'captures', (
      select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
        select c.id, c.round, c.created_at, c.cancelled, h.pseudo as hunter, t.pseudo as target
          from public.captures c
          join public.players h on h.id = c.hunter_id
          join public.players t on t.id = c.target_id
         order by c.created_at desc limit 50) x),
    'chat_enabled', g.chat_enabled,
    'chat_unread', public._chat_unread(null, true),
    'dm_enabled', g.dm_enabled,
    'claims_pending', (select count(*) from public.quest_claims where status = 'en_attente'),
    'log', (
      select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
        select kind, detail, created_at from public.event_log
         order by created_at desc limit 60) x)
  );
end $$;

create or replace function public.org_create_player(p_pseudo text)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v public.players;
begin
  perform public._require_org();
  insert into public.players(pseudo, access_code, capture_code)
  values (trim(p_pseudo), public._new_access_code(), public._new_capture_code())
  returning * into v;
  perform public._log('joueur_cree', jsonb_build_object('joueur', v.pseudo));
  return json_build_object('id', v.id, 'pseudo', v.pseudo, 'access_code', v.access_code);
end $$;

create or replace function public.org_update_player(p_id uuid, p_pseudo text, p_active boolean)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  update public.players
     set pseudo = coalesce(nullif(trim(p_pseudo), ''), pseudo),
         active = coalesce(p_active, active)
   where id = p_id;
end $$;

create or replace function public.org_set_photo(p_id uuid, p_path text)
returns text language plpgsql volatile security definer
set search_path = public
as $$
declare v_old text;
begin
  perform public._require_org();
  select photo_path into v_old from public.players where id = p_id;
  update public.players set photo_path = p_path where id = p_id;
  return v_old; -- le front supprime l'ancienne photo du stockage
end $$;

create or replace function public.org_regenerate_access_code(p_id uuid)
returns text language plpgsql volatile security definer
set search_path = public
as $$
declare v text := public._new_access_code();
begin
  perform public._require_org();
  update public.players set access_code = v where id = p_id;
  update public.devices set player_id = null where player_id = p_id;
  return v;
end $$;

create or replace function public.org_delete_player(p_id uuid)
returns text language plpgsql volatile security definer
set search_path = public
as $$
declare v_path text;
begin
  perform public._require_org();
  if (select status from public.games where id = 1) <> 'accueil' then
    raise exception 'Suppression possible seulement avant le jeu : désactive plutôt le joueur';
  end if;
  delete from public.players where id = p_id returning photo_path into v_path;
  return v_path;
end $$;

create or replace function public.org_start_dispersion(p_round int)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  perform public._require_org();
  if p_round not in (1, 2) then raise exception 'Manche 1 ou 2'; end if;
  select * into g from public.games where id = 1 for update;
  if g.status not in ('accueil', 'regroupement') then
    raise exception 'Impossible pendant une dispersion ou une manche';
  end if;
  update public.assignments set closed_at = now(), close_reason = 'correction' where closed_at is null;
  update public.players set immune_until = null, cooldown_until = null where true;
  update public.challenges set status = 'annule', resolved_at = now() where status = 'active';
  update public.games
     set status = 'dispersion', round = p_round,
         dispersion_started_at = now(),
         start_at = now() + make_interval(mins => g.dispersion_minutes),
         end_at = now() + make_interval(mins => g.dispersion_minutes + g.round_minutes),
         drawn_round = least(drawn_round, p_round - 1),
         round_scored = least(round_scored, p_round - 1),
         updated_at = now()
   where id = 1;
  perform public._log('dispersion', jsonb_build_object('manche', p_round));
  update public.push_jobs set status = 'annule' where status = 'attente';
  perform public._push(null, 'dispersion', 'Dispersion : manche ' || p_round,
    'Disperse-toi ! START dans ' || g.dispersion_minutes || ' min.', 'dispersion', true,
    now(), now() + make_interval(mins => g.dispersion_minutes), p_round);
end $$;

-- Secours : avance le START à maintenant et lance le tirage.
create or replace function public.org_draw_now()
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  perform public._require_org();
  select * into g from public.games where id = 1 for update;
  if g.status <> 'dispersion' then raise exception 'Pas de dispersion en cours'; end if;
  update public.games
     set start_at = now(), end_at = now() + make_interval(mins => g.round_minutes), updated_at = now()
   where id = 1;
  perform public._tick();
end $$;

create or replace function public.org_end_round()
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  if (select status from public.games where id = 1) <> 'manche' then
    raise exception 'Aucune manche en cours';
  end if;
  update public.games set end_at = now(), updated_at = now() where id = 1;
  perform public._tick();
end $$;

create or replace function public.org_set_status(p_status text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  if p_status not in ('accueil', 'regroupement', 'termine') then
    raise exception 'Statut non autorisé';
  end if;
  if (select status from public.games where id = 1) in ('dispersion', 'manche') then
    raise exception 'Termine d''abord la manche en cours';
  end if;
  update public.games set status = p_status, updated_at = now() where id = 1;
  perform public._log('statut', jsonb_build_object('statut', p_status));
end $$;

create or replace function public.org_adjust_points(p_player uuid, p_points int, p_reason text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Motif obligatoire'; end if;
  insert into public.score_events(player_id, round, points, reason, ref)
  values (p_player, (select round from public.games where id = 1), p_points, 'correction', trim(p_reason));
  perform public._log('correction_points', jsonb_build_object(
    'joueur', (select pseudo from public.players where id = p_player), 'points', p_points, 'motif', trim(p_reason)));
end $$;

create or replace function public.org_cancel_capture(p_capture bigint)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare c public.captures;
begin
  perform public._require_org();
  update public.captures set cancelled = true where id = p_capture and not cancelled returning * into c;
  if c.id is null then raise exception 'Capture introuvable ou déjà annulée'; end if;
  insert into public.score_events(player_id, round, points, reason, ref) values
    (c.hunter_id, c.round, -3, 'capture annulée', c.id::text),
    (c.target_id, c.round, 2, 'capture annulée', c.id::text);
  perform public._log('capture_annulee', jsonb_build_object('capture', c.id));
end $$;

-- p_target null = au hasard.
create or replace function public.org_reassign(p_hunter uuid, p_target uuid default null)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare
  g public.games;
  v_old uuid;
begin
  perform public._require_org();
  g := public._tick();
  if g.status <> 'manche' then raise exception 'Aucune manche en cours'; end if;
  if p_target = p_hunter then raise exception 'Un joueur ne peut pas se chasser lui-même'; end if;
  update public.assignments set closed_at = now(), close_reason = 'correction'
   where hunter_id = p_hunter and closed_at is null returning target_id into v_old;
  update public.challenges set status = 'annule', resolved_at = now()
   where hunter_id = p_hunter and status = 'active';
  insert into public.assignments(round, hunter_id, target_id)
  values (g.round, p_hunter, coalesce(p_target, public._pick_target(p_hunter, v_old)));
  perform public._log('reattribution', jsonb_build_object(
    'chasseur', (select pseudo from public.players where id = p_hunter)));
end $$;

create or replace function public.org_send_message(p_player uuid, p_body text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  insert into public.messages(player_id, body) values (p_player, trim(p_body));
  perform public._push(p_player, 'message', 'Message de l''organisation', left(trim(p_body), 180),
    null, true, now(), now() + interval '30 minutes');
end $$;

-- Ping manuel : un joueur (p_player) ou tout le monde (null), même fenêtre que les pings automatiques.
create or replace function public.org_request_position(p_player uuid default null)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games; v_ping bigint;
begin
  perform public._require_org();
  g := public._tick();
  if g.status <> 'manche' then raise exception 'Aucune manche en cours'; end if;
  insert into public.pings(round, kind, scheduled_at, window_end, player_id)
  values (g.round, 'manuel', now(), now() + make_interval(secs => g.ping_window_seconds), p_player)
  returning id into v_ping;
  perform public._push(p_player, 'ping',
    case when p_player is null then 'PING GÉNÉRAL : envoie ta position' else 'PING : envoie ta position' end,
    case when p_player is null
         then 'L''organisation demande la position de tous. Tu as 1 minute. Les positions seront visibles de tous.'
         else 'L''organisation demande ta position. Tu as 1 minute.' end,
    'ping-' || v_ping, true,
    now(), now() + make_interval(secs => g.ping_window_seconds), g.round, v_ping::text);
  perform public._log('ping_manuel', jsonb_build_object(
    'joueur', coalesce((select pseudo from public.players where id = p_player), 'tous')));
end $$;

-- Révèle la dernière position connue d'un joueur à ses chasseurs ou à tous.
create or replace function public.org_reveal_position(p_player uuid, p_scope text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare g public.games;
begin
  perform public._require_org();
  g := public._tick();
  if g.status <> 'manche' then raise exception 'Aucune manche en cours'; end if;
  if p_scope not in ('chasseurs', 'tous') then raise exception 'Portée invalide'; end if;
  if not exists (select 1 from public.positions where player_id = p_player) then
    raise exception 'Ce joueur n''a encore envoyé aucune position';
  end if;
  insert into public.reveals(round, player_id, scope) values (g.round, p_player, p_scope);
  perform public._log('revelation', jsonb_build_object(
    'joueur', (select pseudo from public.players where id = p_player), 'portee', p_scope));
end $$;

-- Après le jeu : efface positions et références de photos ; renvoie les fichiers à supprimer du stockage.
create or replace function public.org_purge()
returns text[] language plpgsql volatile security definer
set search_path = public
as $$
declare v_paths text[];
begin
  perform public._require_org();
  if (select status from public.games where id = 1) in ('dispersion', 'manche') then
    raise exception 'Termine d''abord la manche en cours';
  end if;
  select coalesce(array_agg(photo_path), '{}') into v_paths from public.players where photo_path is not null;
  delete from public.positions where true;
  delete from public.reveals where true;
  delete from public.push_subscriptions where true;
  delete from public.push_jobs where true;
  delete from public.chat_messages where true;
  delete from public.chat_reads where true;
  update public.quest_claims set photo_path = null where photo_path is not null;
  update public.players set photo_path = null where photo_path is not null;
  perform public._log('purge', null);
  return v_paths;
end $$;

create or replace function public.org_reset()
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  delete from public.challenges where true;
  delete from public.assignments where true;
  delete from public.positions where true;
  delete from public.reveals where true;
  delete from public.pings where true;
  delete from public.captures where true;
  delete from public.score_events where true;
  delete from public.code_attempts where true;
  delete from public.messages where true;
  delete from public.event_log where true;
  delete from public.push_jobs where true;
  delete from public.quest_claims where true;
  delete from public.chat_messages where true;
  delete from public.chat_reads where true;
  update public.players set capture_code = public._new_capture_code(capture_code), immune_until = null, cooldown_until = null where true;
  update public.games
     set status = 'accueil', round = 0, drawn_round = 0, round_scored = 0,
         dispersion_started_at = null, start_at = null, end_at = null, updated_at = now()
   where id = 1;
  perform public._log('reinitialisation', null);
end $$;

-- ---------------------------------------------------------------------
-- Notifications web
-- ---------------------------------------------------------------------

-- Le téléphone du joueur enregistre son abonnement (après son accord).
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text,
                                                         p_user_agent text default null)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v_me uuid := public._my_player_id();
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Abonnement invalide';
  end if;
  insert into public.push_subscriptions(player_id, endpoint, p256dh, auth, user_agent)
  values (v_me, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set player_id = excluded.player_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, updated_at = now();
  return json_build_object('ok', true,
    'devices', (select count(*) from public.push_subscriptions where player_id = v_me));
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  delete from public.push_subscriptions
   where endpoint = p_endpoint and player_id = public._my_player_id();
end $$;

-- Pour tester : l'organisateur envoie une notification à un joueur (ou à tous).
create or replace function public.org_test_push(p_player uuid default null)
returns int language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  perform public._push(p_player, 'test', 'Test Wanted', 'Les notifications fonctionnent sur ce téléphone.',
    'test', true, now(), now() + interval '10 minutes');
  return (select count(*) from public.push_subscriptions s join public.players p on p.id = s.player_id
           where p.active and (p_player is null or s.player_id = p_player));
end $$;

-- Réservé à la fonction d'envoi (rôle service) : prend les notifications dues avec leurs destinataires.
create or replace function public.claim_push_jobs()
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v json;
begin
  update public.push_jobs set status = 'expire'
   where status in ('attente', 'envoi') and expires_at < now();
  update public.push_jobs set status = 'echec'
   where status = 'envoi' and locked_at < now() - interval '2 minutes' and attempts >= 3;

  with picked as (
    select id from public.push_jobs
     where send_at <= now()
       and (status = 'attente' or (status = 'envoi' and locked_at < now() - interval '2 minutes'))
     order by send_at
     limit 20
     for update skip locked),
  upd as (
    update public.push_jobs j
       set status = 'envoi', locked_at = now(), attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*)
  select coalesce(json_agg(json_build_object(
           'id', u.id, 'kind', u.kind, 'title', u.title, 'body', u.body,
           'tag', coalesce(u.tag, u.kind || '-' || u.id), 'urgent', u.urgent,
           'ttl', greatest(30, least(86400, extract(epoch from (u.expires_at - now()))::int)),
           'subs', (select coalesce(json_agg(json_build_object(
                             'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::json)
                      from public.push_subscriptions s
                      join public.players p on p.id = s.player_id
                     where p.active and (u.player_id is null or s.player_id = u.player_id)))), '[]'::json)
    into v
    from upd u;
  return v;
end $$;

create or replace function public.finish_push_job(p_id bigint, p_result jsonb)
returns void language sql volatile security definer
set search_path = public
as $$
  update public.push_jobs set status = 'envoye', sent_at = now(), locked_at = null, result = p_result
   where id = p_id;
$$;

create or replace function public.drop_push_subscription(p_endpoint text)
returns void language sql volatile security definer
set search_path = public
as $$ delete from public.push_subscriptions where endpoint = p_endpoint $$;

-- Tâche planifiée (toutes les 10 s) : fait avancer la partie même si aucun téléphone n'est ouvert
-- (START, fin de manche, repérages expirés), puis réveille l'envoi des notifications dues.
create or replace function public._cron_tick()
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._tick();
  perform public._push_kick();
end $$;

-- ---------------------------------------------------------------------
-- Déconnexion
-- ---------------------------------------------------------------------

-- Délie ce téléphone du joueur ou de l'organisation (le code d'accès reste valable).
create or replace function public.logout()
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare d public.devices;
begin
  select * into d from public.devices where auth_uid = auth.uid();
  if d.auth_uid is null then return; end if;
  delete from public.devices where auth_uid = auth.uid();
  perform public._log('deconnexion', jsonb_build_object(
    'joueur', coalesce((select pseudo from public.players where id = d.player_id), 'organisation')));
end $$;

-- ---------------------------------------------------------------------
-- Import des joueurs (tableau Excel : Nom + Pseudo)
-- ---------------------------------------------------------------------

-- p_rows = [{"nom": "...", "pseudo": "..."}, ...]. Les pseudos déjà pris sont ignorés.
create or replace function public.org_import_players(p_rows jsonb)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare
  r jsonb;
  v_pseudo text; v_nom text;
  v public.players;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  perform public._require_org();
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Liste de joueurs attendue'; end if;
  if jsonb_array_length(p_rows) > 300 then raise exception '300 joueurs au maximum par import'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_pseudo := left(trim(coalesce(r->>'pseudo', '')), 30);
    v_nom := nullif(left(trim(coalesce(r->>'nom', '')), 80), '');
    if v_pseudo = '' then
      v_skipped := v_skipped || jsonb_build_object('pseudo', '', 'nom', v_nom, 'motif', 'pseudo vide');
      continue;
    end if;
    if exists (select 1 from public.players where lower(pseudo) = lower(v_pseudo)) then
      v_skipped := v_skipped || jsonb_build_object('pseudo', v_pseudo, 'nom', v_nom, 'motif', 'pseudo déjà pris');
      continue;
    end if;
    insert into public.players(pseudo, full_name, access_code, capture_code)
    values (v_pseudo, v_nom, public._new_access_code(), public._new_capture_code())
    returning * into v;
    v_created := v_created || jsonb_build_object('pseudo', v.pseudo, 'nom', v.full_name, 'access_code', v.access_code);
  end loop;
  perform public._log('import_joueurs', jsonb_build_object(
    'crees', jsonb_array_length(v_created), 'ignores', jsonb_array_length(v_skipped)));
  return json_build_object('created', v_created, 'skipped', v_skipped);
end $$;

create or replace function public.org_set_full_name(p_id uuid, p_name text)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  update public.players set full_name = nullif(left(trim(coalesce(p_name, '')), 80), '') where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Classement détaillé (organisation)
-- ---------------------------------------------------------------------

create or replace function public.org_get_scoreboard()
returns json language plpgsql stable security definer
set search_path = public
as $$
begin
  perform public._require_org();
  return (
    select coalesce(json_agg(x order by x.total desc, x.pseudo), '[]'::json) from (
      select p.id, p.pseudo, p.full_name, p.active,
             coalesce(sum(s.points), 0) as total,
             coalesce(sum(s.points) filter (where s.round = 1), 0) as round1,
             coalesce(sum(s.points) filter (where s.round = 2), 0) as round2,
             (select count(*) from public.captures c where c.hunter_id = p.id and not c.cancelled) as captures,
             (select count(*) from public.captures c where c.target_id = p.id and not c.cancelled) as captured,
             count(*) filter (where s.reason = 'ping manqué') as missed_pings,
             coalesce(sum(s.points) filter (where s.reason = 'bonus survivant'), 0) as bonus,
             coalesce(sum(s.points) filter (where s.reason = 'quête'), 0) as quests,
             coalesce(sum(s.points) filter (where s.reason not in
               ('capture','capturé','ping manqué','bonus survivant','quête')), 0) as corrections
        from public.players p
        left join public.score_events s on s.player_id = p.id
       group by p.id, p.pseudo, p.full_name, p.active) x);
end $$;

-- ---------------------------------------------------------------------
-- Quêtes
-- ---------------------------------------------------------------------

drop function if exists public.org_save_quest(bigint, text, text, int, uuid, int, boolean);
create or replace function public.org_save_quest(p_id bigint, p_title text, p_description text,
                                                 p_points int, p_player uuid, p_round int, p_active boolean,
                                                 p_photo_required boolean default null)
returns bigint language plpgsql volatile security definer
set search_path = public
as $$
declare v_id bigint; v_new boolean := p_id is null;
begin
  perform public._require_org();
  if v_new then
    insert into public.quests(title, description, points, player_id, round, active, photo_required)
    values (trim(p_title), coalesce(trim(p_description), ''), coalesce(p_points, 1), p_player, p_round,
            coalesce(p_active, true), coalesce(p_photo_required, false))
    returning id into v_id;
  else
    update public.quests
       set title = trim(p_title), description = coalesce(trim(p_description), ''),
           points = coalesce(p_points, points), player_id = p_player, round = p_round,
           active = coalesce(p_active, active), photo_required = coalesce(p_photo_required, photo_required)
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Quête introuvable'; end if;
  end if;
  if v_new and coalesce(p_active, true) then
    perform public._push(p_player, 'quete', 'Nouvelle quête : ' || left(trim(p_title), 60),
      'Ouvre l''onglet Quêtes de Wanted.', 'quete-' || v_id, false, now(), now() + interval '30 minutes');
  end if;
  return v_id;
end $$;

create or replace function public.org_delete_quest(p_id bigint)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  delete from public.score_events
   where reason = 'quête' and ref in (select id::text from public.quest_claims where quest_id = p_id);
  delete from public.quests where id = p_id;
end $$;

create or replace function public.org_get_quests()
returns json language plpgsql stable security definer
set search_path = public
as $$
begin
  perform public._require_org();
  return json_build_object(
    'quests', (select coalesce(json_agg(x order by x.id desc), '[]'::json) from (
      select q.id, q.title, q.description, q.points, q.player_id, q.round, q.active, q.created_at, q.photo_required,
             (select pseudo from public.players where id = q.player_id) as for_player,
             (select count(*) from public.quest_claims c where c.quest_id = q.id and c.status = 'validee') as done
        from public.quests q) x),
    'claims', (select coalesce(json_agg(x order by x.status <> 'en_attente', x.created_at desc), '[]'::json) from (
      select c.id, c.quest_id, q.title, q.points, p.pseudo, c.note, c.photo_path, c.status, c.created_at, c.decided_at
        from public.quest_claims c
        join public.quests q on q.id = c.quest_id
        join public.players p on p.id = c.player_id
       order by c.created_at desc limit 200) x));
end $$;

-- Valide (points ajoutés) ou refuse une déclaration ; peut revenir sur sa décision.
create or replace function public.org_decide_claim(p_claim bigint, p_accept boolean)
returns void language plpgsql volatile security definer
set search_path = public
as $$
declare c public.quest_claims; q public.quests; g public.games;
begin
  perform public._require_org();
  select * into c from public.quest_claims where id = p_claim for update;
  if c.id is null then raise exception 'Déclaration introuvable'; end if;
  select * into q from public.quests where id = c.quest_id;
  select * into g from public.games where id = 1;
  delete from public.score_events where reason = 'quête' and ref = c.id::text;
  update public.quest_claims set status = case when p_accept then 'validee' else 'refusee' end, decided_at = now()
   where id = c.id;
  if p_accept then
    insert into public.score_events(player_id, round, points, reason, ref)
    values (c.player_id, coalesce(q.round, g.round), q.points, 'quête', c.id::text);
  end if;
  perform public._push(c.player_id, 'quete',
    case when p_accept then 'Quête validée : ' else 'Quête refusée : ' end || left(q.title, 60),
    case when p_accept then (case when q.points >= 0 then '+' else '' end) || q.points || ' point(s).'
         else 'Vois l''onglet Quêtes.' end,
    'quete-' || q.id, false, now(), now() + interval '30 minutes');
  perform public._log('quete', jsonb_build_object('joueur', (select pseudo from public.players where id = c.player_id),
    'quete', q.title, 'decision', case when p_accept then 'validée' else 'refusée' end));
end $$;

-- Quêtes visibles par le joueur, avec l'état de sa déclaration.
create or replace function public.get_quests()
returns json language plpgsql stable security definer
set search_path = public
as $$
declare v_me uuid := public._my_player_id(); g public.games;
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  select * into g from public.games where id = 1;
  return (select coalesce(json_agg(x order by x.done, x.id desc), '[]'::json) from (
    select q.id, q.title, q.description, q.points, q.round, (q.player_id is not null) as personal,
           q.photo_required, c.status, c.note, (c.photo_path is not null) as has_photo,
           (c.status = 'validee') is true as done
      from public.quests q
      left join public.quest_claims c on c.quest_id = q.id and c.player_id = v_me
     where q.active and (q.player_id is null or q.player_id = v_me)) x);
end $$;

drop function if exists public.claim_quest(bigint, text);
create or replace function public.claim_quest(p_quest bigint, p_note text default null, p_photo text default null)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v_me uuid := public._my_player_id(); q public.quests; c public.quest_claims;
begin
  if v_me is null then raise exception 'Joueur non connecté'; end if;
  select * into q from public.quests
   where id = p_quest and active and (player_id is null or player_id = v_me);
  if q.id is null then raise exception 'Quête indisponible'; end if;
  select * into c from public.quest_claims where quest_id = q.id and player_id = v_me;
  if c.status = 'validee' then return json_build_object('ok', true, 'already', true); end if;
  p_photo := nullif(trim(coalesce(p_photo, '')), '');
  if q.photo_required and p_photo is null then raise exception 'Photo obligatoire pour cette quête'; end if;
  if p_photo is not null and not public._media_ok(p_photo, 'quests', array['jpg']) then
    raise exception 'Photo introuvable : réessaie';
  end if;
  insert into public.quest_claims(quest_id, player_id, note, photo_path)
  values (q.id, v_me, nullif(left(trim(coalesce(p_note, '')), 300), ''), p_photo)
  on conflict (quest_id, player_id) do update
     set note = excluded.note, photo_path = excluded.photo_path,
         status = 'en_attente', created_at = now(), decided_at = null;
  perform public._log('quete_declaree', jsonb_build_object(
    'joueur', (select pseudo from public.players where id = v_me), 'quete', q.title));
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Chat : conversation générale, messages privés, messages vocaux
-- ---------------------------------------------------------------------

-- Fichier déposé par l'appelant lui-même dans le bucket « media » : <dossier>/<auth uid>/<nom>.<ext>.
create or replace function public._media_ok(p_path text, p_folder text, p_exts text[])
returns boolean language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_path is null or auth.uid() is null
     or p_path !~ ('^' || p_folder || '/' || auth.uid()::text || '/[A-Za-z0-9-]{8,64}\.('
                   || array_to_string(p_exts, '|') || ')$') then
    return false;
  end if;
  return exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = p_path);
end $$;

-- Message visible pour ce joueur (p_me) ou pour l'organisation (p_org) ?
-- L'organisation ne lit pas les messages privés entre joueurs.
create or replace function public._chat_visible(m public.chat_messages, p_me uuid, p_org boolean)
returns boolean language sql immutable
as $$
  select (m.to_player is null and not m.to_org)
      or (p_org and (m.to_org or (m.player_id is null and m.to_player is not null)))
      or (p_me is not null and (m.player_id = p_me or m.to_player = p_me))
$$;

-- Conversation d'un message, vue par ce joueur ou par l'organisation :
-- 'all' (générale), 'org' (avec l'organisation, côté joueur) ou l'id de l'autre joueur.
create or replace function public._chat_conv(m public.chat_messages, p_me uuid, p_org boolean)
returns text language sql immutable
as $$
  select case
    when m.to_player is null and not m.to_org then 'all'
    when p_org then coalesce(m.to_player, m.player_id)::text
    when m.to_org or m.player_id is null then 'org'
    when m.player_id = p_me then m.to_player::text
    else m.player_id::text end
$$;

-- Conversations contenant des messages non lus (hors messages envoyés par soi-même).
create or replace function public._chat_unread(p_me uuid, p_org boolean)
returns text[] language sql stable security definer
set search_path = public
as $$
  select coalesce(array_agg(x.conv), '{}') from (
    select public._chat_conv(m, p_me, p_org) as conv, max(m.id) as last_id
      from public.chat_messages m
     where not m.deleted and public._chat_visible(m, p_me, p_org)
       and not (case when p_org then m.player_id is null else m.player_id is not distinct from p_me end)
     group by 1) x
   where x.last_id > coalesce((select r.last_id from public.chat_reads r
                                where r.viewer = coalesce(p_me::text, 'org') and r.conv = x.conv), 0)
$$;

-- Droit de lecture d'un fichier du bucket « media » (règle de stockage).
create or replace function public._can_read_media(p_name text)
returns boolean language sql stable security definer
set search_path = public
as $$
  select public._has_device() and (
       public._is_org()
    or split_part(p_name, '/', 2) = auth.uid()::text
    or exists (select 1 from public.chat_messages m
                where m.media_path = p_name and not m.deleted
                  and public._chat_visible(m, public._my_player_id(), false))
    or exists (select 1 from public.quest_claims c
                where c.photo_path = p_name and c.player_id = public._my_player_id()))
$$;

-- Messages d'une conversation après p_after (ou les 60 derniers) ; marque la conversation comme lue.
drop function if exists public.get_chat(bigint);
create or replace function public.get_chat(p_after bigint default 0, p_conv text default 'all')
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v_me uuid := public._my_player_id(); v_org boolean := public._is_org(); g public.games;
        v_conv text := coalesce(nullif(trim(p_conv), ''), 'all'); v_msgs json; v_last bigint;
begin
  if v_me is null and not v_org then raise exception 'Session requise'; end if;
  select * into g from public.games where id = 1;
  select coalesce(json_agg(x order by x.id), '[]'::json), max(x.id) into v_msgs, v_last from (
    select m.id, m.body, m.created_at, m.deleted, m.media_path, m.media_seconds,
           case when m.player_id is null then 'Organisation'
                else (select pseudo from public.players where id = m.player_id) end as author,
           (m.player_id is null) as is_org,
           (case when v_org then m.player_id is null else m.player_id is not distinct from v_me end) as mine
      from public.chat_messages m
     where m.id > coalesce(p_after, 0) and (not m.deleted or v_org)
       and public._chat_visible(m, v_me, v_org)
       and public._chat_conv(m, v_me, v_org) = v_conv
     order by m.id desc limit 60) x;
  if v_last is not null then
    insert into public.chat_reads(viewer, conv, last_id) values (coalesce(v_me::text, 'org'), v_conv, v_last)
    on conflict (viewer, conv) do update set last_id = greatest(public.chat_reads.last_id, excluded.last_id);
  end if;
  return json_build_object(
    'enabled', g.chat_enabled,
    'dm_enabled', g.dm_enabled,
    'conv', v_conv,
    'messages', v_msgs,
    'unread', public._chat_unread(v_me, v_org),
    -- Destinataires possibles (seulement au premier chargement).
    'contacts', case when coalesce(p_after, 0) = 0 then (
      select coalesce(json_agg(json_build_object('key', c.k, 'name', c.n) order by c.o, lower(c.n)), '[]'::json) from (
        select 'org' as k, 'Organisation' as n, 0 as o where not v_org
        union all
        select p.id::text, p.pseudo, 1 from public.players p
         where p.active and p.id is distinct from v_me and (v_org or g.dm_enabled)) c) end);
end $$;

-- p_to : 'all' (général), 'org' (joueur → organisation) ou l'id d'un joueur (message privé).
-- p_media : message vocal déjà déposé dans le bucket « media » (chat/<auth uid>/...).
drop function if exists public.send_chat(text);
create or replace function public.send_chat(p_body text, p_to text default 'all',
                                            p_media text default null, p_seconds int default null)
returns json language plpgsql volatile security definer
set search_path = public
as $$
declare v_me uuid := public._my_player_id(); v_org boolean := public._is_org(); v_id bigint;
        g public.games; v_to text := coalesce(nullif(trim(p_to), ''), 'all');
        v_to_player uuid; v_to_org boolean := false;
        v_body text := left(trim(coalesce(p_body, '')), 300); v_from text;
begin
  if v_me is null and not v_org then raise exception 'Session requise'; end if;
  select * into g from public.games where id = 1;
  p_media := nullif(trim(coalesce(p_media, '')), '');
  if v_body = '' and p_media is null then raise exception 'Message vide'; end if;
  if not v_org and not (select active from public.players where id = v_me) then
    raise exception 'Joueur désactivé';
  end if;
  if v_to = 'org' then
    if v_org then raise exception 'Destinataire invalide'; end if;
    v_to_org := true;
  elsif v_to <> 'all' then
    begin
      v_to_player := v_to::uuid;
    exception when others then
      raise exception 'Destinataire invalide';
    end;
    if v_to_player is not distinct from v_me
       or not exists (select 1 from public.players where id = v_to_player and active) then
      raise exception 'Destinataire invalide';
    end if;
    if not v_org and not g.dm_enabled then
      raise exception 'Les messages privés entre joueurs sont fermés par l''organisation';
    end if;
  end if;
  if not v_org and v_to = 'all' and not g.chat_enabled then
    raise exception 'Le chat est fermé par l''organisation';
  end if;
  if p_media is not null and not public._media_ok(p_media, 'chat', array['webm','mp4','m4a','ogg','mp3','aac']) then
    raise exception 'Message vocal introuvable : réessaie';
  end if;
  if exists (select 1 from public.chat_messages
              where author_uid = auth.uid() and created_at > now() - interval '3 seconds') then
    raise exception 'Doucement : un message toutes les 3 secondes';
  end if;
  insert into public.chat_messages(player_id, author_uid, body, to_player, to_org, media_path, media_seconds)
  values (case when v_org then null else v_me end, auth.uid(), v_body, v_to_player, v_to_org, p_media,
          case when p_media is null then null else least(greatest(coalesce(p_seconds, 0), 0), 120) end)
  returning id into v_id;
  -- Le destinataire d'un message privé est prévenu sur son téléphone.
  if v_to_player is not null then
    v_from := case when v_org then 'l''organisation' else (select pseudo from public.players where id = v_me) end;
    perform public._push(v_to_player, 'chat', 'Message privé de ' || v_from,
      case when p_media is not null then 'Message vocal' else left(v_body, 120) end,
      'dm-' || coalesce(v_me::text, 'org'), false, now(), now() + interval '30 minutes');
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.org_delete_chat(p_id bigint)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  update public.chat_messages set deleted = true where id = p_id;
end $$;

create or replace function public.org_set_chat(p_enabled boolean)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  update public.games set chat_enabled = p_enabled where id = 1;
  perform public._log('chat', jsonb_build_object('ouvert', p_enabled));
end $$;

-- Ouvre ou ferme les messages privés entre joueurs (les messages avec l'organisation restent possibles).
create or replace function public.org_set_dm(p_enabled boolean)
returns void language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform public._require_org();
  update public.games set dm_enabled = p_enabled where id = 1;
  perform public._log('dm', jsonb_build_object('ouvert', p_enabled));
end $$;

-- Liste des fichiers du bucket « media » (vocaux, photos de quêtes), pour la purge.
create or replace function public.org_media_files()
returns text[] language plpgsql stable security definer
set search_path = public
as $$
begin
  perform public._require_org();
  return (select coalesce(array_agg(o.name), '{}') from storage.objects o where o.bucket_id = 'media');
end $$;

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------

do $$
declare f record;
begin
  -- Tout fermer...
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '\_%' or p.proname like 'org\_%'
            or p.proname in ('claim_player','claim_organizer','get_my_state','submit_capture','get_leaderboard',
                             'send_position','get_perimeter','spot_target','save_push_subscription',
                             'remove_push_subscription','claim_push_jobs','finish_push_job',
                             'drop_push_subscription','logout','get_quests','claim_quest','get_chat','send_chat'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- ...puis ouvrir uniquement l'API aux sessions (anonymes) authentifiées.
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'org\_%'
            or p.proname in ('claim_player','claim_organizer','get_my_state','submit_capture',
                             'get_leaderboard','send_position','get_perimeter','spot_target','_has_device','_is_org','_can_read_media',
                             'save_push_subscription','remove_push_subscription',
                             'logout','get_quests','claim_quest','get_chat','send_chat'))
  loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- La fonction d'envoi (clé serveur, rôle service_role) lit les clés VAPID et la file.
grant select, insert, update on table public.app_private_config to service_role;
grant execute on function public.claim_push_jobs() to service_role;
grant execute on function public.finish_push_job(bigint, jsonb) to service_role;
grant execute on function public.drop_push_subscription(text) to service_role;

-- Adresse de la fonction d'envoi et jeton partagé (générés une fois, jamais exposés au front).
insert into public.app_private_config(key, value) values
  ('push_dispatch_url', 'https://yimuwduqpytkvnkrppeo.supabase.co/functions/v1/push-dispatch'),
  ('push_dispatch_token', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Tâche toutes les 10 s (remplacée si elle existe déjà).
select cron.schedule('wanted_tick', '10 seconds', 'select public._cron_tick()');

-- ---------------------------------------------------------------------
-- Photos : bucket privé
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false;

drop policy if exists "wanted_photos_read" on storage.objects;
create policy "wanted_photos_read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public._has_device());

drop policy if exists "wanted_photos_insert" on storage.objects;
create policy "wanted_photos_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public._is_org());

drop policy if exists "wanted_photos_delete" on storage.objects;
create policy "wanted_photos_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public._is_org());

-- Messages vocaux et photos de preuve des quêtes : bucket privé « media ».
-- Chacun dépose dans son propre dossier (<chat|quests>/<auth uid>/...) ; la lecture suit les droits du chat.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 5242880,
        array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "wanted_media_read" on storage.objects;
create policy "wanted_media_read" on storage.objects for select to authenticated
  using (bucket_id = 'media' and public._can_read_media(name));

drop policy if exists "wanted_media_insert" on storage.objects;
create policy "wanted_media_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public._has_device()
              and (storage.foldername(name))[1] in ('chat', 'quests')
              and (storage.foldername(name))[2] = auth.uid()::text);

drop policy if exists "wanted_media_delete" on storage.objects;
create policy "wanted_media_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public._is_org());

-- ---------------------------------------------------------------------
-- Partie unique + code organisateur (généré une seule fois)
-- ---------------------------------------------------------------------

insert into public.games(id, org_code)
values (1, public._random_code(8, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'))
on conflict (id) do nothing;

select org_code as "Code organisateur (à garder pour toi)" from public.games where id = 1;
