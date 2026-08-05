CREATE TABLE reconciliation_mapping_version (
    id text PRIMARY KEY,
    division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
    principal_code text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    original_name text NOT NULL,
    mime_type text NOT NULL,
    byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
    sha256 text NOT NULL CHECK (length(sha256) = 64),
    workbook bytea NOT NULL,
    uploaded_by text NOT NULL,
    uploaded_by_name text NOT NULL,
    uploaded_by_email text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp NOT NULL,
    UNIQUE (division, principal_code, version)
);

CREATE UNIQUE INDEX reconciliation_mapping_version_active_idx
    ON reconciliation_mapping_version (division, principal_code)
    WHERE is_active = true;

CREATE INDEX reconciliation_mapping_version_lookup_idx
    ON reconciliation_mapping_version (division, principal_code, created_at);

CREATE TABLE reconciliation_run (
    id text PRIMARY KEY,
    division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
    principal_code text NOT NULL,
    mapping_version_id text NOT NULL REFERENCES reconciliation_mapping_version(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('processing', 'success', 'failed')),
    uploaded_by text NOT NULL,
    uploaded_by_name text NOT NULL,
    uploaded_by_email text NOT NULL,
    input_files jsonb NOT NULL,
    summary jsonb,
    issues jsonb,
    error text,
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
    started_at timestamp NOT NULL,
    finished_at timestamp
);

CREATE INDEX reconciliation_run_lookup_idx
    ON reconciliation_run (division, principal_code, started_at);

CREATE INDEX reconciliation_run_uploader_idx
    ON reconciliation_run (uploaded_by, started_at);

CREATE INDEX reconciliation_run_mapping_version_idx
    ON reconciliation_run (mapping_version_id);
