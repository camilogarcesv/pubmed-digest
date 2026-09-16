-- A profile has one total source order across journals and queries.
CREATE UNIQUE INDEX sources_profile_position ON profile_sources(user_id,profile_version,position);
