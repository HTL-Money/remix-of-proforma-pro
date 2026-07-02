
CREATE TABLE public.scenarios (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  share_id text NOT NULL UNIQUE,
  recruit_name text NOT NULL,
  recruit_email text NOT NULL,
  recruit_phone text NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenarios_share_id_idx ON public.scenarios(share_id);

GRANT SELECT, INSERT ON public.scenarios TO anon;
GRANT SELECT, INSERT ON public.scenarios TO authenticated;
GRANT ALL ON public.scenarios TO service_role;

ALTER TABLE public.scenarios ENABLE ROW LEVEL SECURITY;

-- Anyone with a share_id can read the scenario (link acts as the credential)
CREATE POLICY "Public can read scenarios"
  ON public.scenarios FOR SELECT
  TO anon, authenticated
  USING (true);

-- Anyone can save a new scenario (recruiter tool, no login)
CREATE POLICY "Public can create scenarios"
  ON public.scenarios FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    char_length(recruit_name) BETWEEN 1 AND 120
    AND char_length(recruit_email) BETWEEN 3 AND 254
    AND char_length(recruit_phone) BETWEEN 3 AND 40
    AND char_length(share_id) BETWEEN 6 AND 40
  );
