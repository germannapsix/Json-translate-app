-- Tabla para almacenar las traducciones realizadas
CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  original_json TEXT NOT NULL,
  translated_json TEXT NOT NULL,
  total_keys INTEGER NOT NULL,
  translated_keys INTEGER NOT NULL,
  failed_keys INTEGER NOT NULL,
  processing_time_ms INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla para almacenar las estadísticas detalladas de cada clave traducida
CREATE TABLE IF NOT EXISTS translation_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  translation_id INTEGER NOT NULL,
  json_key TEXT NOT NULL,
  original_value TEXT NOT NULL,
  translated_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  error_message TEXT,
  translation_time_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (translation_id) REFERENCES translations(id)
);

-- Índices para mejorar el rendimiento
CREATE INDEX IF NOT EXISTS idx_translations_session_id ON translations(session_id);
CREATE INDEX IF NOT EXISTS idx_translations_created_at ON translations(created_at);
CREATE INDEX IF NOT EXISTS idx_translation_details_translation_id ON translation_details(translation_id);
CREATE INDEX IF NOT EXISTS idx_translation_details_status ON translation_details(status);