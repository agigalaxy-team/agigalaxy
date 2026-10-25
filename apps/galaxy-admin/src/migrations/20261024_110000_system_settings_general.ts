import {MigrateUpArgs,MigrateDownArgs,sql} from '@payloadcms/db-postgres';
export async function up({db}:MigrateUpArgs):Promise<void>{
 await db.execute(sql`
  ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS system_general_revision numeric DEFAULT 0;
  ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS system_general_operation jsonb;
  ALTER TABLE _site_settings_v ADD COLUMN IF NOT EXISTS version_system_general_revision numeric DEFAULT 0;
  ALTER TABLE _site_settings_v ADD COLUMN IF NOT EXISTS version_system_general_operation jsonb;
 `);
}
export async function down({db}:MigrateDownArgs):Promise<void>{
 await db.execute(sql`
  ALTER TABLE site_settings DROP COLUMN IF EXISTS system_general_operation;
  ALTER TABLE site_settings DROP COLUMN IF EXISTS system_general_revision;
  ALTER TABLE _site_settings_v DROP COLUMN IF EXISTS version_system_general_operation;
  ALTER TABLE _site_settings_v DROP COLUMN IF EXISTS version_system_general_revision;
 `);
}
