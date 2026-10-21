import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_operators_role" AS ENUM('administrator', 'reader');
  CREATE TYPE "public"."enum_site_pages_blocks_notice_tone" AS ENUM('information', 'service-impact');
  CREATE TYPE "public"."enum_site_pages_blocks_release_links_channel" AS ENUM('stable');
  CREATE TYPE "public"."enum_site_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__site_pages_v_blocks_notice_tone" AS ENUM('information', 'service-impact');
  CREATE TYPE "public"."enum__site_pages_v_blocks_release_links_channel" AS ENUM('stable');
  CREATE TYPE "public"."enum__site_pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_site_settings_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__site_settings_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "operators" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"external_id" varchar NOT NULL,
  	"display_name" varchar NOT NULL,
  	"role" "enum_operators_role" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_pages_blocks_hero_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"href" varchar,
  	"description" varchar
  );
  
  CREATE TABLE "site_pages_blocks_hero" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"text" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages_blocks_prose" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"body" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages_blocks_link_list_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"href" varchar,
  	"description" varchar
  );
  
  CREATE TABLE "site_pages_blocks_link_list" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages_blocks_image" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"media_id" uuid,
  	"caption" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages_blocks_notice" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"tone" "enum_site_pages_blocks_notice_tone" DEFAULT 'information',
  	"title" varchar,
  	"text" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages_blocks_release_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"channel" "enum_site_pages_blocks_release_links_channel" DEFAULT 'stable',
  	"label" varchar DEFAULT '下载银河客户端',
  	"block_name" varchar
  );
  
  CREATE TABLE "site_pages" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"title" varchar,
  	"path" varchar,
  	"description" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_site_pages_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_site_pages_v_blocks_hero_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"label" varchar,
  	"href" varchar,
  	"description" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_hero" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"heading" varchar,
  	"text" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_prose" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"heading" varchar,
  	"body" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_link_list_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"label" varchar,
  	"href" varchar,
  	"description" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_link_list" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"heading" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_image" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"media_id" uuid,
  	"caption" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_notice" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"tone" "enum__site_pages_v_blocks_notice_tone" DEFAULT 'information',
  	"title" varchar,
  	"text" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v_blocks_release_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"_path" text NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"heading" varchar,
  	"channel" "enum__site_pages_v_blocks_release_links_channel" DEFAULT 'stable',
  	"label" varchar DEFAULT '下载银河客户端',
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_site_pages_v" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"parent_id" uuid,
  	"version_title" varchar,
  	"version_path" varchar,
  	"version_description" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__site_pages_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  CREATE TABLE "media" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"alt" varchar NOT NULL,
  	"credit" varchar,
  	"published" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric,
  	"sizes_thumbnail_url" varchar,
  	"sizes_thumbnail_width" numeric,
  	"sizes_thumbnail_height" numeric,
  	"sizes_thumbnail_mime_type" varchar,
  	"sizes_thumbnail_filesize" numeric,
  	"sizes_thumbnail_filename" varchar
  );
  
  CREATE TABLE "payload_kv" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"operators_id" uuid,
  	"site_pages_id" uuid,
  	"media_id" uuid
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"operators_id" uuid
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_settings_footer_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"href" varchar
  );
  
  CREATE TABLE "site_settings" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_title" varchar DEFAULT '银河',
  	"description" varchar,
  	"_status" "enum_site_settings_status" DEFAULT 'draft',
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "_site_settings_v_version_footer_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"label" varchar,
  	"href" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_site_settings_v" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"version_site_title" varchar DEFAULT '银河',
  	"version_description" varchar,
  	"version__status" "enum__site_settings_v_version_status" DEFAULT 'draft',
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  ALTER TABLE "site_pages_blocks_hero_links" ADD CONSTRAINT "site_pages_blocks_hero_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_hero" ADD CONSTRAINT "site_pages_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_prose" ADD CONSTRAINT "site_pages_blocks_prose_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_link_list_links" ADD CONSTRAINT "site_pages_blocks_link_list_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages_blocks_link_list"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_link_list" ADD CONSTRAINT "site_pages_blocks_link_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_image" ADD CONSTRAINT "site_pages_blocks_image_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_image" ADD CONSTRAINT "site_pages_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_notice" ADD CONSTRAINT "site_pages_blocks_notice_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_pages_blocks_release_links" ADD CONSTRAINT "site_pages_blocks_release_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_hero_links" ADD CONSTRAINT "_site_pages_v_blocks_hero_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_hero" ADD CONSTRAINT "_site_pages_v_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_prose" ADD CONSTRAINT "_site_pages_v_blocks_prose_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_link_list_links" ADD CONSTRAINT "_site_pages_v_blocks_link_list_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v_blocks_link_list"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_link_list" ADD CONSTRAINT "_site_pages_v_blocks_link_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_image" ADD CONSTRAINT "_site_pages_v_blocks_image_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_image" ADD CONSTRAINT "_site_pages_v_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_notice" ADD CONSTRAINT "_site_pages_v_blocks_notice_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v_blocks_release_links" ADD CONSTRAINT "_site_pages_v_blocks_release_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_pages_v" ADD CONSTRAINT "_site_pages_v_parent_id_site_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."site_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_operators_fk" FOREIGN KEY ("operators_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_pages_fk" FOREIGN KEY ("site_pages_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_operators_fk" FOREIGN KEY ("operators_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_footer_links" ADD CONSTRAINT "site_settings_footer_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_site_settings_v_version_footer_links" ADD CONSTRAINT "_site_settings_v_version_footer_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_site_settings_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "operators_external_id_idx" ON "operators" USING btree ("external_id");
  CREATE INDEX "operators_updated_at_idx" ON "operators" USING btree ("updated_at");
  CREATE INDEX "operators_created_at_idx" ON "operators" USING btree ("created_at");
  CREATE INDEX "site_pages_blocks_hero_links_order_idx" ON "site_pages_blocks_hero_links" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_hero_links_parent_id_idx" ON "site_pages_blocks_hero_links" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_hero_order_idx" ON "site_pages_blocks_hero" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_hero_parent_id_idx" ON "site_pages_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_hero_path_idx" ON "site_pages_blocks_hero" USING btree ("_path");
  CREATE INDEX "site_pages_blocks_prose_order_idx" ON "site_pages_blocks_prose" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_prose_parent_id_idx" ON "site_pages_blocks_prose" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_prose_path_idx" ON "site_pages_blocks_prose" USING btree ("_path");
  CREATE INDEX "site_pages_blocks_link_list_links_order_idx" ON "site_pages_blocks_link_list_links" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_link_list_links_parent_id_idx" ON "site_pages_blocks_link_list_links" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_link_list_order_idx" ON "site_pages_blocks_link_list" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_link_list_parent_id_idx" ON "site_pages_blocks_link_list" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_link_list_path_idx" ON "site_pages_blocks_link_list" USING btree ("_path");
  CREATE INDEX "site_pages_blocks_image_order_idx" ON "site_pages_blocks_image" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_image_parent_id_idx" ON "site_pages_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_image_path_idx" ON "site_pages_blocks_image" USING btree ("_path");
  CREATE INDEX "site_pages_blocks_image_media_idx" ON "site_pages_blocks_image" USING btree ("media_id");
  CREATE INDEX "site_pages_blocks_notice_order_idx" ON "site_pages_blocks_notice" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_notice_parent_id_idx" ON "site_pages_blocks_notice" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_notice_path_idx" ON "site_pages_blocks_notice" USING btree ("_path");
  CREATE INDEX "site_pages_blocks_release_links_order_idx" ON "site_pages_blocks_release_links" USING btree ("_order");
  CREATE INDEX "site_pages_blocks_release_links_parent_id_idx" ON "site_pages_blocks_release_links" USING btree ("_parent_id");
  CREATE INDEX "site_pages_blocks_release_links_path_idx" ON "site_pages_blocks_release_links" USING btree ("_path");
  CREATE UNIQUE INDEX "site_pages_path_idx" ON "site_pages" USING btree ("path");
  CREATE INDEX "site_pages_updated_at_idx" ON "site_pages" USING btree ("updated_at");
  CREATE INDEX "site_pages_created_at_idx" ON "site_pages" USING btree ("created_at");
  CREATE INDEX "site_pages__status_idx" ON "site_pages" USING btree ("_status");
  CREATE INDEX "_site_pages_v_blocks_hero_links_order_idx" ON "_site_pages_v_blocks_hero_links" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_hero_links_parent_id_idx" ON "_site_pages_v_blocks_hero_links" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_hero_order_idx" ON "_site_pages_v_blocks_hero" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_hero_parent_id_idx" ON "_site_pages_v_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_hero_path_idx" ON "_site_pages_v_blocks_hero" USING btree ("_path");
  CREATE INDEX "_site_pages_v_blocks_prose_order_idx" ON "_site_pages_v_blocks_prose" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_prose_parent_id_idx" ON "_site_pages_v_blocks_prose" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_prose_path_idx" ON "_site_pages_v_blocks_prose" USING btree ("_path");
  CREATE INDEX "_site_pages_v_blocks_link_list_links_order_idx" ON "_site_pages_v_blocks_link_list_links" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_link_list_links_parent_id_idx" ON "_site_pages_v_blocks_link_list_links" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_link_list_order_idx" ON "_site_pages_v_blocks_link_list" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_link_list_parent_id_idx" ON "_site_pages_v_blocks_link_list" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_link_list_path_idx" ON "_site_pages_v_blocks_link_list" USING btree ("_path");
  CREATE INDEX "_site_pages_v_blocks_image_order_idx" ON "_site_pages_v_blocks_image" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_image_parent_id_idx" ON "_site_pages_v_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_image_path_idx" ON "_site_pages_v_blocks_image" USING btree ("_path");
  CREATE INDEX "_site_pages_v_blocks_image_media_idx" ON "_site_pages_v_blocks_image" USING btree ("media_id");
  CREATE INDEX "_site_pages_v_blocks_notice_order_idx" ON "_site_pages_v_blocks_notice" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_notice_parent_id_idx" ON "_site_pages_v_blocks_notice" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_notice_path_idx" ON "_site_pages_v_blocks_notice" USING btree ("_path");
  CREATE INDEX "_site_pages_v_blocks_release_links_order_idx" ON "_site_pages_v_blocks_release_links" USING btree ("_order");
  CREATE INDEX "_site_pages_v_blocks_release_links_parent_id_idx" ON "_site_pages_v_blocks_release_links" USING btree ("_parent_id");
  CREATE INDEX "_site_pages_v_blocks_release_links_path_idx" ON "_site_pages_v_blocks_release_links" USING btree ("_path");
  CREATE INDEX "_site_pages_v_parent_idx" ON "_site_pages_v" USING btree ("parent_id");
  CREATE INDEX "_site_pages_v_version_version_path_idx" ON "_site_pages_v" USING btree ("version_path");
  CREATE INDEX "_site_pages_v_version_version_updated_at_idx" ON "_site_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_site_pages_v_version_version_created_at_idx" ON "_site_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_site_pages_v_version_version__status_idx" ON "_site_pages_v" USING btree ("version__status");
  CREATE INDEX "_site_pages_v_created_at_idx" ON "_site_pages_v" USING btree ("created_at");
  CREATE INDEX "_site_pages_v_updated_at_idx" ON "_site_pages_v" USING btree ("updated_at");
  CREATE INDEX "_site_pages_v_latest_idx" ON "_site_pages_v" USING btree ("latest");
  CREATE INDEX "_site_pages_v_autosave_idx" ON "_site_pages_v" USING btree ("autosave");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "media_sizes_thumbnail_sizes_thumbnail_filename_idx" ON "media" USING btree ("sizes_thumbnail_filename");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_operators_id_idx" ON "payload_locked_documents_rels" USING btree ("operators_id");
  CREATE INDEX "payload_locked_documents_rels_site_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("site_pages_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_operators_id_idx" ON "payload_preferences_rels" USING btree ("operators_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "site_settings_footer_links_order_idx" ON "site_settings_footer_links" USING btree ("_order");
  CREATE INDEX "site_settings_footer_links_parent_id_idx" ON "site_settings_footer_links" USING btree ("_parent_id");
  CREATE INDEX "site_settings__status_idx" ON "site_settings" USING btree ("_status");
  CREATE INDEX "_site_settings_v_version_footer_links_order_idx" ON "_site_settings_v_version_footer_links" USING btree ("_order");
  CREATE INDEX "_site_settings_v_version_footer_links_parent_id_idx" ON "_site_settings_v_version_footer_links" USING btree ("_parent_id");
  CREATE INDEX "_site_settings_v_version_version__status_idx" ON "_site_settings_v" USING btree ("version__status");
  CREATE INDEX "_site_settings_v_created_at_idx" ON "_site_settings_v" USING btree ("created_at");
  CREATE INDEX "_site_settings_v_updated_at_idx" ON "_site_settings_v" USING btree ("updated_at");
  CREATE INDEX "_site_settings_v_latest_idx" ON "_site_settings_v" USING btree ("latest");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "operators" CASCADE;
  DROP TABLE "site_pages_blocks_hero_links" CASCADE;
  DROP TABLE "site_pages_blocks_hero" CASCADE;
  DROP TABLE "site_pages_blocks_prose" CASCADE;
  DROP TABLE "site_pages_blocks_link_list_links" CASCADE;
  DROP TABLE "site_pages_blocks_link_list" CASCADE;
  DROP TABLE "site_pages_blocks_image" CASCADE;
  DROP TABLE "site_pages_blocks_notice" CASCADE;
  DROP TABLE "site_pages_blocks_release_links" CASCADE;
  DROP TABLE "site_pages" CASCADE;
  DROP TABLE "_site_pages_v_blocks_hero_links" CASCADE;
  DROP TABLE "_site_pages_v_blocks_hero" CASCADE;
  DROP TABLE "_site_pages_v_blocks_prose" CASCADE;
  DROP TABLE "_site_pages_v_blocks_link_list_links" CASCADE;
  DROP TABLE "_site_pages_v_blocks_link_list" CASCADE;
  DROP TABLE "_site_pages_v_blocks_image" CASCADE;
  DROP TABLE "_site_pages_v_blocks_notice" CASCADE;
  DROP TABLE "_site_pages_v_blocks_release_links" CASCADE;
  DROP TABLE "_site_pages_v" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "site_settings_footer_links" CASCADE;
  DROP TABLE "site_settings" CASCADE;
  DROP TABLE "_site_settings_v_version_footer_links" CASCADE;
  DROP TABLE "_site_settings_v" CASCADE;
  DROP TYPE "public"."enum_operators_role";
  DROP TYPE "public"."enum_site_pages_blocks_notice_tone";
  DROP TYPE "public"."enum_site_pages_blocks_release_links_channel";
  DROP TYPE "public"."enum_site_pages_status";
  DROP TYPE "public"."enum__site_pages_v_blocks_notice_tone";
  DROP TYPE "public"."enum__site_pages_v_blocks_release_links_channel";
  DROP TYPE "public"."enum__site_pages_v_version_status";
  DROP TYPE "public"."enum_site_settings_status";
  DROP TYPE "public"."enum__site_settings_v_version_status";`)
}
