DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factelec_owner') THEN
    CREATE ROLE factelec_owner LOGIN PASSWORD 'owner_pw' BYPASSRLS CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factelec_app') THEN
    CREATE ROLE factelec_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factelec_worker') THEN
    CREATE ROLE factelec_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
  END IF;
END $$;
GRANT ALL ON DATABASE factelec TO factelec_owner;
ALTER SCHEMA public OWNER TO factelec_owner;
GRANT CREATE, USAGE ON SCHEMA public TO factelec_owner;
