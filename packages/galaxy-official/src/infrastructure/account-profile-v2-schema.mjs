// Registry wiring is owned by the release integrator. This changes profile
// presentation only; no registration, verification, privacy or login defaults.
export const accountProfileV2MigrationSql=`
ALTER TABLE official_account_profiles_v1
 ADD COLUMN avatar_key text CHECK(avatar_key IN ('orbit','camera','book','leaf','mountain','palette','music','sunrise')),
 ADD COLUMN bio text NOT NULL DEFAULT '' CHECK(char_length(bio)<=500);
`;
