-- Datos de ejemplo para pruebas de desarrollo
INSERT OR IGNORE INTO translations (
  session_id, source_language, target_language, 
  original_json, translated_json, 
  total_keys, translated_keys, failed_keys, processing_time_ms
) VALUES 
  ('demo-session-1', 'en', 'es', 
   '{"welcome": "Welcome", "goodbye": "Goodbye"}', 
   '{"welcome": "Bienvenido", "goodbye": "Adiós"}',
   2, 2, 0, 1500),
  ('demo-session-2', 'es', 'fr', 
   '{"hola": "Hola mundo", "gracias": "Gracias"}', 
   '{"hola": "Bonjour le monde", "gracias": "Merci"}',
   2, 2, 0, 1200);

INSERT OR IGNORE INTO translation_details (
  translation_id, json_key, original_value, translated_value, 
  status, translation_time_ms
) VALUES 
  (1, 'welcome', 'Welcome', 'Bienvenido', 'success', 750),
  (1, 'goodbye', 'Goodbye', 'Adiós', 'success', 750),
  (2, 'hola', 'Hola mundo', 'Bonjour le monde', 'success', 600),
  (2, 'gracias', 'Gracias', 'Merci', 'success', 600);