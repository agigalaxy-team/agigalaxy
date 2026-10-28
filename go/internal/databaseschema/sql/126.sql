
ALTER TABLE official_account_profiles_v1
 ADD COLUMN avatar_key text CHECK(avatar_key IN ('orbit','camera','book','leaf','mountain','palette','music','sunrise')),
 ADD COLUMN bio text NOT NULL DEFAULT '' CHECK(char_length(bio)<=500);
