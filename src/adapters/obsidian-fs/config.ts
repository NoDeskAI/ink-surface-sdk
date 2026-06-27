export interface ObsidianFsConfig {
  vault_root: string;
  base_dir?: string;
  documents_dir?: string;
  create_source_notes?: boolean;
  open_after_export?: boolean;
  vault_name_or_id?: string;
}

export interface ObsidianFsTarget {
  target_id: string;
  vault_root: string;
  base_dir: string;
  documents_dir: string;
  notes_dir: string;
  sources_dir: string;
  tasks_dir: string;
  summaries_dir: string;
  concepts_dir: string;
  assets_dir: string;
  vault_name_or_id?: string;
  create_source_notes: boolean;
}
