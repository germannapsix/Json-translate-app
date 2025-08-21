import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database;
  AI: Ai;
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// Rate limiting para evitar "Too many API requests"
const BATCH_SIZE = 5; // Máximo 5 traducciones por batch
const BATCH_DELAY = 1000; // 1 segundo entre batches

// Función auxiliar para traducir texto usando Cloudflare AI con rate limiting
async function translateText(ai: Ai, text: string, sourceLang: string, targetLang: string): Promise<string> {
  try {
    // Limitar la longitud del texto para evitar timeouts
    const maxLength = 1000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    
    const response = await ai.run('@cf/meta/m2m100-1.2b', {
      text: truncatedText,
      source_lang: sourceLang === 'auto' ? undefined : sourceLang,
      target_lang: targetLang
    });
    
    return response.translated_text || text;
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Return original text if translation fails
  }
}

// Función para traducir múltiples textos en batches
async function translateBatch(ai: Ai, texts: string[], sourceLang: string, targetLang: string): Promise<string[]> {
  const results: string[] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    
    // Procesar el batch actual
    const batchPromises = batch.map(text => translateText(ai, text, sourceLang, targetLang));
    const batchResults = await Promise.all(batchPromises);
    
    results.push(...batchResults);
    
    // Esperar antes del siguiente batch (excepto en el último)
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }
  
  return results;
}

// Función para extraer todos los strings de un objeto JSON
function extractStrings(obj: any, path: string = ''): { text: string; path: string }[] {
  const strings: { text: string; path: string }[] = [];
  
  if (typeof obj === 'string') {
    strings.push({ text: obj, path });
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      strings.push(...extractStrings(obj[i], `${path}[${i}]`));
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      strings.push(...extractStrings(value, currentPath));
    }
  }
  
  return strings;
}

// Función para reconstruir el objeto con las traducciones
function reconstructObject(obj: any, translations: Map<string, string>, path: string = ''): any {
  if (typeof obj === 'string') {
    return translations.get(path) || obj;
  } else if (Array.isArray(obj)) {
    const result = [];
    for (let i = 0; i < obj.length; i++) {
      result[i] = reconstructObject(obj[i], translations, `${path}[${i}]`);
    }
    return result;
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      result[key] = reconstructObject(value, translations, currentPath);
    }
    return result;
  }
  
  return obj; // Return primitive values unchanged (numbers, booleans, null)
}

// Función optimizada para traducir objetos JSON con batching
async function translateJsonObject(
  ai: Ai, 
  obj: any, 
  sourceLang: string, 
  targetLang: string, 
  details: any[], 
  translationId: number
): Promise<any> {
  const startTime = Date.now();
  
  try {
    // Extraer todos los strings del objeto
    const stringEntries = extractStrings(obj);
    
    // Verificar si hay strings para traducir
    if (stringEntries.length === 0) {
      return obj; // No hay strings para traducir
    }
    
    // Limitar el número de traducciones para evitar timeouts
    const MAX_TRANSLATIONS = 20;
    if (stringEntries.length > MAX_TRANSLATIONS) {
      // Si hay demasiados strings, traducir solo los primeros y dejar el resto igual
      const limitedEntries = stringEntries.slice(0, MAX_TRANSLATIONS);
      const texts = limitedEntries.map(entry => entry.text);
      
      // Traducir en batches
      const translatedTexts = await translateBatch(ai, texts, sourceLang, targetLang);
      
      // Crear mapa de traducciones
      const translationMap = new Map<string, string>();
      limitedEntries.forEach((entry, index) => {
        translationMap.set(entry.path, translatedTexts[index]);
        
        // Agregar a detalles
        const endTime = Date.now();
        details.push({
          translation_id: translationId,
          json_key: entry.path,
          original_value: entry.text,
          translated_value: translatedTexts[index],
          status: 'success',
          translation_time_ms: Math.round((endTime - startTime) / limitedEntries.length)
        });
      });
      
      // Agregar strings no traducidos a detalles
      stringEntries.slice(MAX_TRANSLATIONS).forEach(entry => {
        details.push({
          translation_id: translationId,
          json_key: entry.path,
          original_value: entry.text,
          translated_value: entry.text,
          status: 'skipped',
          error_message: 'Skipped due to rate limiting',
          translation_time_ms: 0
        });
      });
      
      // Reconstruir objeto con traducciones limitadas
      return reconstructObject(obj, translationMap);
    } else {
      // Traducir todos los strings
      const texts = stringEntries.map(entry => entry.text);
      const translatedTexts = await translateBatch(ai, texts, sourceLang, targetLang);
      
      // Crear mapa de traducciones
      const translationMap = new Map<string, string>();
      stringEntries.forEach((entry, index) => {
        translationMap.set(entry.path, translatedTexts[index]);
        
        // Agregar a detalles
        const endTime = Date.now();
        details.push({
          translation_id: translationId,
          json_key: entry.path,
          original_value: entry.text,
          translated_value: translatedTexts[index],
          status: 'success',
          translation_time_ms: Math.round((endTime - startTime) / stringEntries.length)
        });
      });
      
      // Reconstruir objeto con todas las traducciones
      return reconstructObject(obj, translationMap);
    }
  } catch (error) {
    console.error('Translation error:', error);
    
    // En caso de error, agregar todos los strings como fallidos
    const stringEntries = extractStrings(obj);
    stringEntries.forEach(entry => {
      details.push({
        translation_id: translationId,
        json_key: entry.path,
        original_value: entry.text,
        translated_value: entry.text,
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Translation failed',
        translation_time_ms: 0
      });
    });
    
    return obj; // Return original object on error
  }
}

// Función para contar claves de strings en un objeto JSON
function countStringKeys(obj: any): number {
  let count = 0;
  
  if (typeof obj === 'string') {
    return 1;
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      count += countStringKeys(item);
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      count += countStringKeys(value);
    }
  }
  
  return count;
}

// API endpoint for translating JSON
app.post('/api/translate', async (c) => {
  const { env } = c;
  const { jsonData, sourceLang, targetLang } = await c.req.json();
  
  if (!jsonData || !targetLang) {
    return c.json({ error: 'JSON data and target language are required' }, 400);
  }
  
  const sessionId = crypto.randomUUID();
  const startTime = Date.now();
  
  // Timeout para evitar que el worker se cuelgue
  const TRANSLATION_TIMEOUT = 25000; // 25 seconds (Cloudflare Workers timeout is 30s)
  
  try {
    // Parse JSON if it's a string
    const parsedJson = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    
    // Count total keys
    const totalKeys = countStringKeys(parsedJson);
    
    // Limitar el tamaño del JSON para evitar timeouts
    if (totalKeys > 50) {
      return c.json({ 
        error: 'JSON too large', 
        message: `El JSON contiene ${totalKeys} strings. Máximo permitido: 50. Por favor use un JSON más pequeño.` 
      }, 400);
    }
    
    // Create translation record
    const translationResult = await env.DB.prepare(`
      INSERT INTO translations (session_id, source_language, target_language, original_json, translated_json, total_keys, translated_keys, failed_keys, processing_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(sessionId, sourceLang, targetLang, JSON.stringify(parsedJson), '', totalKeys, 0, 0, 0).run();
    
    const translationId = translationResult.meta.last_row_id;
    
    // Crear timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Translation timeout - please try with a smaller JSON')), TRANSLATION_TIMEOUT);
    });
    
    // Translate JSON object with batching and rate limiting
    const details: any[] = [];
    const translationPromise = translateJsonObject(env.AI, parsedJson, sourceLang, targetLang, details, translationId);
    
    // Usar Promise.race para timeout
    const translatedJson = await Promise.race([translationPromise, timeoutPromise]) as any;
    
    const endTime = Date.now();
    const processingTime = endTime - startTime;
    
    // Count successful and failed translations
    const successCount = details.filter(d => d.status === 'success').length;
    const failedCount = details.filter(d => d.status === 'failed').length;
    const skippedCount = details.filter(d => d.status === 'skipped').length;
    
    // Update translation record with results
    await env.DB.prepare(`
      UPDATE translations 
      SET translated_json = ?, translated_keys = ?, failed_keys = ?, processing_time_ms = ?
      WHERE id = ?
    `).bind(JSON.stringify(translatedJson), successCount, failedCount + skippedCount, processingTime, translationId).run();
    
    // Insert translation details (batch insert for better performance)
    if (details.length > 0) {
      const detailInserts = details.map(detail => 
        env.DB.prepare(`
          INSERT INTO translation_details (translation_id, json_key, original_value, translated_value, status, error_message, translation_time_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          detail.translation_id,
          detail.json_key,
          detail.original_value,
          detail.translated_value,
          detail.status,
          detail.error_message || null,
          detail.translation_time_ms
        )
      );
      
      await env.DB.batch(detailInserts);
    }
    
    return c.json({
      success: true,
      translationId,
      sessionId,
      translatedJson,
      statistics: {
        totalKeys,
        translatedKeys: successCount,
        failedKeys: failedCount,
        skippedKeys: skippedCount,
        processingTimeMs: processingTime,
        averageTimePerKey: totalKeys > 0 ? processingTime / totalKeys : 0
      },
      details,
      warning: skippedCount > 0 ? `${skippedCount} strings were skipped due to rate limiting` : null
    });
    
  } catch (error) {
    console.error('Translation error:', error);
    
    // Manejar diferentes tipos de errores
    let errorMessage = 'Translation failed';
    let statusCode = 500;
    
    if (error instanceof Error) {
      if (error.message.includes('timeout')) {
        errorMessage = 'Translation timeout - please try with a smaller JSON';
        statusCode = 408;
      } else if (error.message.includes('Too many API requests')) {
        errorMessage = 'Rate limit exceeded - please wait a moment and try again';
        statusCode = 429;
      } else {
        errorMessage = error.message;
      }
    }
    
    return c.json({ 
      error: 'Translation failed', 
      message: errorMessage,
      suggestion: 'Try with a smaller JSON file or wait a few seconds before retrying'
    }, statusCode);
  }
});

// API endpoint for getting translation statistics
app.get('/api/translations/:id/stats', async (c) => {
  const { env } = c;
  const translationId = c.req.param('id');
  
  try {
    // Get translation info
    const translation = await env.DB.prepare(`
      SELECT * FROM translations WHERE id = ?
    `).bind(translationId).first();
    
    if (!translation) {
      return c.json({ error: 'Translation not found' }, 404);
    }
    
    // Get detailed statistics
    const details = await env.DB.prepare(`
      SELECT * FROM translation_details WHERE translation_id = ? ORDER BY created_at
    `).bind(translationId).all();
    
    return c.json({
      translation,
      details: details.results,
      summary: {
        totalKeys: translation.total_keys,
        translatedKeys: translation.translated_keys,
        failedKeys: translation.failed_keys,
        successRate: translation.total_keys > 0 ? (translation.translated_keys / translation.total_keys * 100).toFixed(2) : 0,
        processingTimeMs: translation.processing_time_ms,
        averageTimePerKey: translation.total_keys > 0 ? (translation.processing_time_ms / translation.total_keys).toFixed(2) : 0
      }
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    return c.json({ 
      error: 'Failed to get statistics', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// API endpoint for getting all translations
app.get('/api/translations', async (c) => {
  const { env } = c;
  
  try {
    const translations = await env.DB.prepare(`
      SELECT id, session_id, source_language, target_language, 
             total_keys, translated_keys, failed_keys, processing_time_ms, created_at
      FROM translations 
      ORDER BY created_at DESC
      LIMIT 50
    `).all();
    
    return c.json({
      translations: translations.results,
      total: translations.results.length
    });
    
  } catch (error) {
    console.error('Get translations error:', error);
    return c.json({ 
      error: 'Failed to get translations', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// API endpoint for getting supported languages
app.get('/api/languages', (c) => {
  const languages = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'it', name: 'Italiano' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'zh', name: '中文' },
    { code: 'ar', name: 'العربية' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'sv', name: 'Svenska' },
    { code: 'pl', name: 'Polski' }
  ];
  
  return c.json({ languages });
});

// Main page route
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="es" data-theme="light">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Traductor de JSON - Napsix Chat</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
        <link href="/static/napsix-style.css" rel="stylesheet">
        <script>
            // Configure Tailwind to use CSS variables
            tailwind.config = {
                theme: {
                    extend: {
                        colors: {
                            primary: 'oklch(var(--primary))',
                            secondary: 'oklch(var(--secondary))',
                            background: 'var(--background)',
                            foreground: 'var(--foreground)',
                            card: 'var(--card)',
                            'card-foreground': 'var(--card-foreground)',
                            border: 'var(--border)',
                            input: 'var(--input)',
                            ring: 'var(--ring)'
                        }
                    }
                }
            }
        </script>
    </head>
    <body class="min-h-screen"
          style="background-color: var(--background); color: var(--foreground);">
        
        <!-- Theme Toggle -->
        <div class="theme-toggle" onclick="toggleTheme()">
            <i id="theme-icon" class="fas fa-moon"></i>
        </div>
        <div class="container mx-auto px-4 py-8">
            <div class="max-w-7xl mx-auto">
                <!-- Header -->
                <div class="text-center mb-8 animate-fade-in">
                    <h1 class="text-5xl font-bold mb-3" style="color: var(--foreground);">
                        <i class="fas fa-language mr-3" style="color: var(--primary);"></i>
                        Traductor de Documentos JSON
                    </h1>
                    <p class="text-xl opacity-80" style="color: var(--foreground);">
                        Traduce archivos JSON completos manteniendo su estructura original
                    </p>
                    <div class="mt-4 text-sm opacity-60">
                        <i class="fas fa-magic mr-2"></i>
                        Powered by Napsix Chat AI • Cloudflare Workers
                    </div>
                </div>
                
                <!-- Main Content -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <!-- Left Panel: Upload and Configuration -->
                    <div class="space-y-6">
                        <!-- File Upload -->
                        <div class="card p-6 animate-slide-up">
                            <h2 class="text-xl font-semibold mb-4" style="color: var(--card-foreground);">
                                <i class="fas fa-upload mr-2" style="color: var(--primary);"></i>
                                Cargar JSON
                            </h2>
                            
                            <div id="drop-zone" class="file-drop-zone p-8 text-center cursor-pointer">
                                <i class="fas fa-cloud-upload-alt text-4xl mb-4 opacity-60" style="color: var(--primary);"></i>
                                <p class="mb-2" style="color: var(--card-foreground);">Arrastra y suelta tu archivo JSON aquí</p>
                                <p class="text-sm mb-4 opacity-70" style="color: var(--card-foreground);">o haz clic para seleccionar</p>
                                <input type="file" id="file-input" accept=".json" class="hidden">
                                <button onclick="document.getElementById('file-input').click()" 
                                        class="btn-primary">
                                    <i class="fas fa-folder-open mr-2"></i>
                                    Seleccionar Archivo
                                </button>
                            </div>
                            
                            <!-- JSON Editor -->
                            <div class="mt-6">
                                <label class="block text-sm font-medium mb-3" style="color: var(--card-foreground);">
                                    <i class="fas fa-code mr-2"></i>
                                    O pega tu JSON aquí:
                                </label>
                                <textarea id="json-input" 
                                         class="json-editor w-full h-36 p-4 resize-none" 
                                         placeholder='{\n  "welcome": "Hello World",\n  "app": {\n    "name": "Mi Aplicación",\n    "version": "1.0.0"\n  }\n}'></textarea>
                                <div class="mt-2 text-xs opacity-60" style="color: var(--card-foreground);">
                                    <i class="fas fa-info-circle mr-1"></i>
                                    Formato JSON válido requerido
                                </div>
                            </div>
                        </div>
                        
                        <!-- Language Selection -->
                        <div class="card p-6 animate-slide-up" style="animation-delay: 0.1s;">
                            <h2 class="text-xl font-semibold mb-4" style="color: var(--card-foreground);">
                                <i class="fas fa-globe mr-2" style="color: var(--secondary);"></i>
                                Configuración de Idiomas
                            </h2>
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-medium mb-3" style="color: var(--card-foreground);">
                                        <i class="fas fa-language mr-2"></i>
                                        Idioma Origen
                                    </label>
                                    <select id="source-lang" class="input w-full">
                                        <option value="auto">🔍 Detectar automáticamente</option>
                                    </select>
                                </div>
                                
                                <div>
                                    <label class="block text-sm font-medium mb-3" style="color: var(--card-foreground);">
                                        <i class="fas fa-bullseye mr-2" style="color: var(--destructive);"></i>
                                        Idioma Destino *
                                    </label>
                                    <select id="target-lang" class="input w-full">
                                        <option value="">🎯 Seleccionar idioma...</option>
                                    </select>
                                </div>
                            </div>
                            
                            <button id="translate-btn" 
                                    class="btn-secondary w-full mt-6 py-4 text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                                <i class="fas fa-magic mr-2"></i>
                                Traducir JSON
                            </button>
                            
                            <div class="mt-4 text-xs opacity-60 text-center" style="color: var(--card-foreground);">
                                <i class="fas fa-shield-alt mr-1"></i>
                                Procesamiento seguro con IA de Cloudflare
                            </div>
                        </div>
                    </div>
                    
                    <!-- Right Panel: Results and Statistics -->
                    <div class="space-y-6">
                        <!-- Translation Progress -->
                        <div id="progress-panel" class="card p-6 hidden animate-slide-up">
                            <h2 class="text-xl font-semibold mb-4" style="color: var(--card-foreground);">
                                <i class="fas fa-cogs mr-2" style="color: var(--primary);"></i>
                                Progreso de Traducción
                            </h2>
                            
                            <!-- Estado actual -->
                            <div class="mb-6">
                                <div id="current-status" class="status-indicator status-preparing mb-4">
                                    <div class="loading-dot"></div>
                                    <div class="loading-dot"></div>
                                    <div class="loading-dot"></div>
                                    <span id="status-text">Preparando traducción...</span>
                                </div>
                                
                                <div class="flex justify-between text-sm mb-2" style="color: var(--card-foreground);">
                                    <span id="progress-label">Iniciando...</span>
                                    <span id="progress-text">0%</span>
                                </div>
                                
                                <div class="progress-container">
                                    <div id="progress-bar" class="progress-bar" style="width: 0%"></div>
                                </div>
                                
                                <!-- Estimación de tiempo -->
                                <div class="flex justify-between text-xs mt-2 opacity-70" style="color: var(--card-foreground);">
                                    <span>
                                        <i class="fas fa-clock mr-1"></i>
                                        Tiempo transcurrido: <span id="elapsed-time">0s</span>
                                    </span>
                                    <span>
                                        <i class="fas fa-hourglass-half mr-1"></i>
                                        Tiempo estimado: <span id="estimated-time">Calculando...</span>
                                    </span>
                                </div>
                            </div>
                            
                            <!-- Detalles del proceso -->
                            <div class="space-y-2 text-sm">
                                <div class="flex items-center justify-between py-2 border-b border-opacity-20" style="border-color: var(--border);">
                                    <span class="flex items-center">
                                        <i id="step-1-icon" class="fas fa-circle-notch fa-spin mr-2 opacity-50"></i>
                                        Análisis del JSON
                                    </span>
                                    <span id="step-1-status" class="text-xs opacity-60">Pendiente</span>
                                </div>
                                
                                <div class="flex items-center justify-between py-2 border-b border-opacity-20" style="border-color: var(--border);">
                                    <span class="flex items-center">
                                        <i id="step-2-icon" class="fas fa-circle mr-2 opacity-30"></i>
                                        Traducción de contenido
                                    </span>
                                    <span id="step-2-status" class="text-xs opacity-60">Esperando</span>
                                </div>
                                
                                <div class="flex items-center justify-between py-2 border-b border-opacity-20" style="border-color: var(--border);">
                                    <span class="flex items-center">
                                        <i id="step-3-icon" class="fas fa-circle mr-2 opacity-30"></i>
                                        Generación de estadísticas
                                    </span>
                                    <span id="step-3-status" class="text-xs opacity-60">Esperando</span>
                                </div>
                                
                                <div class="flex items-center justify-between py-2">
                                    <span class="flex items-center">
                                        <i id="step-4-icon" class="fas fa-circle mr-2 opacity-30"></i>
                                        Finalización
                                    </span>
                                    <span id="step-4-status" class="text-xs opacity-60">Esperando</span>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Statistics -->
                        <div id="stats-panel" class="card p-6 hidden animate-slide-up" style="animation-delay: 0.2s;">
                            <h2 class="text-xl font-semibold mb-6" style="color: var(--card-foreground);">
                                <i class="fas fa-chart-bar mr-2" style="color: var(--chart-1);"></i>
                                Estadísticas de Traducción
                            </h2>
                            
                            <div class="grid grid-cols-2 gap-4 mb-6">
                                <div class="stat-success p-4 rounded-lg">
                                    <div class="flex items-center justify-between">
                                        <div>
                                            <div class="text-2xl font-bold" id="translated-count">0</div>
                                            <div class="text-sm opacity-80">Claves Traducidas</div>
                                        </div>
                                        <i class="fas fa-check-circle text-2xl opacity-60"></i>
                                    </div>
                                </div>
                                
                                <div class="stat-error p-4 rounded-lg">
                                    <div class="flex items-center justify-between">
                                        <div>
                                            <div class="text-2xl font-bold" id="failed-count">0</div>
                                            <div class="text-sm opacity-80">Fallos</div>
                                        </div>
                                        <i class="fas fa-exclamation-circle text-2xl opacity-60"></i>
                                    </div>
                                </div>
                                
                                <div class="stat-time p-4 rounded-lg">
                                    <div class="flex items-center justify-between">
                                        <div>
                                            <div class="text-2xl font-bold" id="total-time">0ms</div>
                                            <div class="text-sm opacity-80">Tiempo Total</div>
                                        </div>
                                        <i class="fas fa-stopwatch text-2xl opacity-60"></i>
                                    </div>
                                </div>
                                
                                <div class="stat-avg p-4 rounded-lg">
                                    <div class="flex items-center justify-between">
                                        <div>
                                            <div class="text-2xl font-bold" id="avg-time">0ms</div>
                                            <div class="text-sm opacity-80">Tiempo Promedio</div>
                                        </div>
                                        <i class="fas fa-tachometer-alt text-2xl opacity-60"></i>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="mb-4">
                                <div class="flex justify-between items-center mb-3">
                                    <span class="text-sm font-medium" style="color: var(--card-foreground);">
                                        <i class="fas fa-trophy mr-2" style="color: var(--chart-2);"></i>
                                        Tasa de Éxito
                                    </span>
                                    <span id="success-rate-text" class="text-sm font-bold" style="color: var(--chart-2);">0%</span>
                                </div>
                                <div class="progress-container h-4">
                                    <div id="success-rate-bar" class="progress-bar" style="width: 0%; background: linear-gradient(90deg, var(--chart-2), var(--secondary));"></div>
                                </div>
                            </div>
                            
                            <!-- Métricas adicionales -->
                            <div class="grid grid-cols-3 gap-2 text-xs">
                                <div class="text-center p-2 rounded" style="background-color: oklch(from var(--chart-3) l c h / 0.1);">
                                    <div class="font-semibold" style="color: var(--chart-3);" id="keys-per-second">0</div>
                                    <div class="opacity-70" style="color: var(--chart-3);">Claves/seg</div>
                                </div>
                                <div class="text-center p-2 rounded" style="background-color: oklch(from var(--chart-4) l c h / 0.1);">
                                    <div class="font-semibold" style="color: var(--chart-4);" id="efficiency-score">0%</div>
                                    <div class="opacity-70" style="color: var(--chart-4);">Eficiencia</div>
                                </div>
                                <div class="text-center p-2 rounded" style="background-color: oklch(from var(--chart-5) l c h / 0.1);">
                                    <div class="font-semibold" style="color: var(--chart-5);" id="total-chars">0</div>
                                    <div class="opacity-70" style="color: var(--chart-5);">Caracteres</div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Result JSON -->
                        <div id="result-panel" class="card p-6 hidden animate-slide-up" style="animation-delay: 0.3s;">
                            <div class="flex justify-between items-center mb-4">
                                <h2 class="text-xl font-semibold" style="color: var(--card-foreground);">
                                    <i class="fas fa-file-code mr-2" style="color: var(--chart-2);"></i>
                                    JSON Traducido
                                </h2>
                                <div class="flex gap-2">
                                    <button id="copy-btn" 
                                            class="btn-secondary px-3 py-2 text-sm"
                                            onclick="copyToClipboard()">
                                        <i class="fas fa-copy mr-1"></i>
                                        Copiar
                                    </button>
                                    <button id="download-btn" 
                                            class="btn-primary px-4 py-2">
                                        <i class="fas fa-download mr-2"></i>
                                        Descargar
                                    </button>
                                </div>
                            </div>
                            
                            <textarea id="result-json" 
                                     class="json-editor w-full h-80 p-4 resize-none"
                                     readonly
                                     style="background-color: var(--input);"></textarea>
                                     
                            <div class="mt-3 flex justify-between text-xs opacity-60" style="color: var(--card-foreground);">
                                <span>
                                    <i class="fas fa-check-circle mr-1"></i>
                                    JSON válido generado
                                </span>
                                <span id="json-size">0 bytes</span>
                            </div>
                        </div>
                        
                        <!-- Translation History -->
                        <div class="card p-6 animate-slide-up" style="animation-delay: 0.4s;">
                            <div class="flex justify-between items-center mb-6">
                                <h2 class="text-xl font-semibold" style="color: var(--card-foreground);">
                                    <i class="fas fa-history mr-2" style="color: var(--chart-3);"></i>
                                    Historial de Traducciones
                                </h2>
                                <button id="refresh-history-btn" 
                                        class="btn-secondary px-3 py-2 text-sm">
                                    <i class="fas fa-sync-alt mr-1"></i>
                                    Actualizar
                                </button>
                            </div>
                            
                            <div id="history-list" class="space-y-3">
                                <!-- History items will be loaded here -->
                            </div>
                            
                            <div id="no-history" class="text-center py-8 opacity-60 hidden" style="color: var(--card-foreground);">
                                <i class="fas fa-clock text-3xl mb-3 opacity-40"></i>
                                <p>No hay traducciones aún</p>
                                <p class="text-xs mt-1">Realiza tu primera traducción para ver el historial</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            let currentTranslation = null;
            let translationStartTime = 0;
            let progressInterval = null;
            let timeUpdateInterval = null;
            
            // Theme management
            function toggleTheme() {
                const html = document.documentElement;
                const currentTheme = html.getAttribute('data-theme');
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                html.setAttribute('data-theme', newTheme);
                
                const icon = document.getElementById('theme-icon');
                icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
                
                localStorage.setItem('theme', newTheme);
            }
            
            // Load saved theme
            function loadTheme() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                const icon = document.getElementById('theme-icon');
                icon.className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
            }
            
            // Copy to clipboard function
            function copyToClipboard() {
                const textarea = document.getElementById('result-json');
                textarea.select();
                document.execCommand('copy');
                
                const btn = document.getElementById('copy-btn');
                const originalText = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check mr-1"></i>Copiado';
                
                setTimeout(() => {
                    btn.innerHTML = originalText;
                }, 2000);
            }
            
            // Initialize app
            document.addEventListener('DOMContentLoaded', function() {
                loadTheme();
                loadLanguages();
                loadTranslationHistory();
                setupEventListeners();
            });
            
            // Setup event listeners
            function setupEventListeners() {
                const dropZone = document.getElementById('drop-zone');
                const fileInput = document.getElementById('file-input');
                const translateBtn = document.getElementById('translate-btn');
                const downloadBtn = document.getElementById('download-btn');
                const refreshBtn = document.getElementById('refresh-history-btn');
                
                // File drop functionality
                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.classList.add('dragover');
                });
                
                dropZone.addEventListener('dragleave', () => {
                    dropZone.classList.remove('dragover');
                });
                
                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.classList.remove('dragover');
                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                        handleFileSelect(files[0]);
                    }
                });
                
                // File input change
                fileInput.addEventListener('change', (e) => {
                    if (e.target.files.length > 0) {
                        handleFileSelect(e.target.files[0]);
                    }
                });
                
                // Translate button
                translateBtn.addEventListener('click', translateJSON);
                
                // Download button
                downloadBtn.addEventListener('click', downloadTranslatedJSON);
                
                // Refresh history button
                refreshBtn.addEventListener('click', loadTranslationHistory);
            }
            
            // Load supported languages
            async function loadLanguages() {
                try {
                    const response = await axios.get('/api/languages');
                    const languages = response.data.languages;
                    
                    const sourceSelect = document.getElementById('source-lang');
                    const targetSelect = document.getElementById('target-lang');
                    
                    languages.forEach(lang => {
                        const sourceOption = new Option(lang.name, lang.code);
                        const targetOption = new Option(lang.name, lang.code);
                        sourceSelect.appendChild(sourceOption);
                        targetSelect.appendChild(targetOption);
                    });
                } catch (error) {
                    console.error('Error loading languages:', error);
                }
            }
            
            // Handle file selection
            function handleFileSelect(file) {
                if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
                    alert('Por favor selecciona un archivo JSON válido.');
                    return;
                }
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    try {
                        const jsonContent = e.target.result;
                        JSON.parse(jsonContent); // Validate JSON
                        document.getElementById('json-input').value = jsonContent;
                    } catch (error) {
                        alert('El archivo no contiene JSON válido.');
                    }
                };
                reader.readAsText(file);
            }
            
            // Translate JSON with improved error handling
            async function translateJSON() {
                const jsonInput = document.getElementById('json-input').value;
                const sourceLang = document.getElementById('source-lang').value;
                const targetLang = document.getElementById('target-lang').value;
                
                if (!jsonInput.trim()) {
                    showErrorMessage('Por favor ingresa o carga un archivo JSON.');
                    return;
                }
                
                if (!targetLang) {
                    showErrorMessage('Por favor selecciona un idioma destino.');
                    return;
                }
                
                let parsedJson;
                try {
                    parsedJson = JSON.parse(jsonInput);
                } catch (error) {
                    showErrorMessage('El JSON no es válido. Por favor revisa la sintaxis.');
                    return;
                }
                
                // Verificar tamaño del JSON
                const stringCount = countJSONStrings(parsedJson);
                if (stringCount > 50) {
                    showErrorMessage(\`El JSON es muy grande (\${stringCount} strings). Máximo permitido: 50. Por favor usa un JSON más pequeño.\`);
                    return;
                }
                
                if (stringCount === 0) {
                    showErrorMessage('El JSON no contiene strings para traducir.');
                    return;
                }
                
                // Show progress panel
                showProgressPanel();
                
                try {
                    const response = await axios.post('/api/translate', {
                        jsonData: jsonInput,
                        sourceLang: sourceLang || 'auto',
                        targetLang: targetLang
                    });
                    
                    currentTranslation = response.data;
                    
                    // Mostrar advertencia si hay strings omitidos
                    if (response.data.warning) {
                        showWarningMessage(response.data.warning);
                    }
                    
                    displayTranslationResults(currentTranslation);
                    hideProgressPanel();
                    loadTranslationHistory();
                    
                } catch (error) {
                    console.error('Translation error:', error);
                    hideProgressPanel();
                    
                    let errorMessage = 'Error durante la traducción';
                    
                    if (error.response?.status === 429) {
                        errorMessage = 'Límite de velocidad excedido. Por favor espera un momento y vuelve a intentar.';
                    } else if (error.response?.status === 408) {
                        errorMessage = 'Tiempo de espera agotado. Intenta con un JSON más pequeño.';
                    } else if (error.response?.status === 400) {
                        errorMessage = error.response.data.message || 'Datos inválidos';
                    } else {
                        errorMessage = error.response?.data?.message || error.message || 'Error desconocido';
                    }
                    
                    showErrorMessage(errorMessage);
                }
            }
            
            // Función para contar strings en JSON (frontend)
            function countJSONStrings(obj) {
                let count = 0;
                if (typeof obj === 'string') {
                    return 1;
                } else if (Array.isArray(obj)) {
                    for (const item of obj) {
                        count += countJSONStrings(item);
                    }
                } else if (obj && typeof obj === 'object') {
                    for (const value of Object.values(obj)) {
                        count += countJSONStrings(value);
                    }
                }
                return count;
            }
            
            // Función para mostrar errores mejorada
            function showErrorMessage(message) {
                const modal = document.createElement('div');
                modal.className = 'fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4';
                modal.innerHTML = \`
                    <div class="card max-w-md w-full p-6 animate-slide-up" style="background-color: var(--card); border: 2px solid var(--destructive);">
                        <div class="text-center">
                            <i class="fas fa-exclamation-triangle text-4xl mb-4" style="color: var(--destructive);"></i>
                            <h3 class="text-lg font-bold mb-3" style="color: var(--destructive);">Error</h3>
                            <p class="mb-6" style="color: var(--card-foreground);">\${message}</p>
                            <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                    class="btn-primary px-6 py-2">
                                <i class="fas fa-check mr-2"></i>
                                Entendido
                            </button>
                        </div>
                    </div>
                \`;
                document.body.appendChild(modal);
                
                // Auto-remove after 10 seconds
                setTimeout(() => {
                    if (modal.parentNode) {
                        modal.remove();
                    }
                }, 10000);
            }
            
            // Función para mostrar advertencias
            function showWarningMessage(message) {
                const banner = document.createElement('div');
                banner.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 z-50 max-w-md';
                banner.innerHTML = \`
                    <div class="stat-avg p-4 rounded-lg shadow-lg animate-slide-up">
                        <div class="flex items-center gap-3">
                            <i class="fas fa-exclamation-circle"></i>
                            <span class="font-medium">\${message}</span>
                            <button onclick="this.parentElement.parentElement.parentElement.remove()" class="ml-auto">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                \`;
                document.body.appendChild(banner);
                
                // Auto-remove after 8 seconds
                setTimeout(() => {
                    if (banner.parentNode) {
                        banner.remove();
                    }
                }, 8000);
            }
            
            // Advanced progress management with time estimation
            function showProgressPanel() {
                document.getElementById('progress-panel').classList.remove('hidden');
                document.getElementById('translate-btn').disabled = true;
                
                translationStartTime = Date.now();
                
                // Reset progress elements
                resetProgressSteps();
                
                // Start time tracking
                timeUpdateInterval = setInterval(updateElapsedTime, 100);
                
                // Simulate realistic progress with steps
                simulateTranslationProgress();
            }
            
            function resetProgressSteps() {
                // Reset all steps
                for(let i = 1; i <= 4; i++) {
                    const icon = document.getElementById(\`step-\${i}-icon\`);
                    const status = document.getElementById(\`step-\${i}-status\`);
                    
                    icon.className = 'fas fa-circle mr-2 opacity-30';
                    status.textContent = 'Esperando';
                }
                
                // Start first step
                const firstIcon = document.getElementById('step-1-icon');
                firstIcon.className = 'fas fa-circle-notch fa-spin mr-2 opacity-80';
                document.getElementById('step-1-status').textContent = 'En proceso...';
                
                // Update status indicator
                updateStatusIndicator('preparing', 'Preparando traducción...');
            }
            
            function updateStatusIndicator(phase, text) {
                const indicator = document.getElementById('current-status');
                const statusText = document.getElementById('status-text');
                
                // Remove all status classes
                indicator.className = 'status-indicator';
                
                // Add current phase class
                switch(phase) {
                    case 'preparing':
                        indicator.classList.add('status-preparing');
                        break;
                    case 'translating':
                        indicator.classList.add('status-translating');
                        break;
                    case 'processing':
                        indicator.classList.add('status-processing');
                        break;
                    case 'completing':
                        indicator.classList.add('status-completing');
                        break;
                    case 'completed':
                        indicator.classList.add('status-completed');
                        break;
                }
                
                statusText.textContent = text;
            }
            
            function simulateTranslationProgress() {
                let step = 1;
                let progress = 0;
                const totalSteps = 4;
                
                progressInterval = setInterval(() => {
                    const stepProgress = Math.random() * 3 + 1; // 1-4% per tick
                    progress += stepProgress;
                    
                    // Update progress bar
                    const clampedProgress = Math.min(progress, 95);
                    document.getElementById('progress-bar').style.width = clampedProgress + '%';
                    document.getElementById('progress-text').textContent = Math.round(clampedProgress) + '%';
                    
                    // Update progress label and steps
                    if (progress >= 20 && step === 1) {
                        completeStep(1);
                        startStep(2);
                        updateStatusIndicator('translating', 'Traduciendo contenido...');
                        document.getElementById('progress-label').textContent = 'Analizando estructura JSON...';
                        step = 2;
                    } else if (progress >= 50 && step === 2) {
                        completeStep(2);
                        startStep(3);
                        updateStatusIndicator('processing', 'Procesando estadísticas...');
                        document.getElementById('progress-label').textContent = 'Traduciendo claves...';
                        step = 3;
                    } else if (progress >= 80 && step === 3) {
                        completeStep(3);
                        startStep(4);
                        updateStatusIndicator('completing', 'Finalizando proceso...');
                        document.getElementById('progress-label').textContent = 'Generando estadísticas...';
                        step = 4;
                    }
                    
                    // Update estimated time
                    updateEstimatedTime(progress);
                    
                    if (progress >= 95) {
                        clearInterval(progressInterval);
                        // Don't complete automatically - wait for real completion
                    }
                }, 200);
            }
            
            function completeStep(stepNum) {
                const icon = document.getElementById(\`step-\${stepNum}-icon\`);
                const status = document.getElementById(\`step-\${stepNum}-status\`);
                
                icon.className = 'fas fa-check-circle mr-2 text-green-500';
                status.textContent = 'Completado';
            }
            
            function startStep(stepNum) {
                const icon = document.getElementById(\`step-\${stepNum}-icon\`);
                const status = document.getElementById(\`step-\${stepNum}-status\`);
                
                icon.className = 'fas fa-circle-notch fa-spin mr-2 opacity-80';
                status.textContent = 'En proceso...';
            }
            
            function updateElapsedTime() {
                const elapsed = (Date.now() - translationStartTime) / 1000;
                document.getElementById('elapsed-time').textContent = elapsed.toFixed(1) + 's';
            }
            
            function updateEstimatedTime(progress) {
                if (progress > 5) {
                    const elapsed = (Date.now() - translationStartTime) / 1000;
                    const estimated = (elapsed / progress) * 100;
                    const remaining = Math.max(0, estimated - elapsed);
                    
                    if (remaining > 0) {
                        document.getElementById('estimated-time').textContent = remaining.toFixed(1) + 's restantes';
                    } else {
                        document.getElementById('estimated-time').textContent = 'Finalizando...';
                    }
                }
            }
            
            function hideProgressPanel() {
                // Complete final step
                completeStep(4);
                updateStatusIndicator('completed', '¡Traducción completada exitosamente!');
                
                // Finish progress bar
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-text').textContent = '100%';
                document.getElementById('progress-label').textContent = 'Proceso finalizado';
                document.getElementById('estimated-time').textContent = 'Completado';
                
                // Clear intervals
                if (progressInterval) {
                    clearInterval(progressInterval);
                    progressInterval = null;
                }
                
                if (timeUpdateInterval) {
                    clearInterval(timeUpdateInterval);
                    timeUpdateInterval = null;
                }
                
                // Hide panel after delay
                setTimeout(() => {
                    document.getElementById('progress-panel').classList.add('hidden');
                    document.getElementById('translate-btn').disabled = false;
                }, 2000);
            }
            
            // Display translation results with enhanced metrics
            function displayTranslationResults(data) {
                const stats = data.statistics;
                
                // Basic statistics
                document.getElementById('translated-count').textContent = stats.translatedKeys;
                document.getElementById('failed-count').textContent = stats.failedKeys;
                document.getElementById('total-time').textContent = stats.processingTimeMs + 'ms';
                document.getElementById('avg-time').textContent = Math.round(stats.averageTimePerKey) + 'ms';
                
                // Success rate
                const successRate = stats.totalKeys > 0 ? (stats.translatedKeys / stats.totalKeys * 100) : 0;
                document.getElementById('success-rate-bar').style.width = successRate + '%';
                document.getElementById('success-rate-text').textContent = Math.round(successRate) + '%';
                
                // Additional metrics
                const keysPerSecond = stats.processingTimeMs > 0 ? (stats.translatedKeys / (stats.processingTimeMs / 1000)).toFixed(1) : 0;
                document.getElementById('keys-per-second').textContent = keysPerSecond;
                
                const efficiency = successRate; // Same as success rate for now
                document.getElementById('efficiency-score').textContent = Math.round(efficiency) + '%';
                
                // Count total characters in original JSON
                const originalText = JSON.stringify(data.translatedJson);
                const totalChars = originalText.length;
                document.getElementById('total-chars').textContent = totalChars > 1000 ? 
                    (totalChars / 1000).toFixed(1) + 'k' : totalChars;
                
                // Show translated JSON with size info
                const translatedJsonText = JSON.stringify(data.translatedJson, null, 2);
                document.getElementById('result-json').value = translatedJsonText;
                
                const jsonSize = new Blob([translatedJsonText]).size;
                document.getElementById('json-size').textContent = jsonSize > 1024 ? 
                    (jsonSize / 1024).toFixed(1) + ' KB' : jsonSize + ' bytes';
                
                // Show panels with animation
                setTimeout(() => {
                    document.getElementById('stats-panel').classList.remove('hidden');
                }, 100);
                
                setTimeout(() => {
                    document.getElementById('result-panel').classList.remove('hidden');
                }, 200);
            }
            
            // Download translated JSON
            function downloadTranslatedJSON() {
                if (!currentTranslation) return;
                
                const jsonString = JSON.stringify(currentTranslation.translatedJson, null, 2);
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = 'translated.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
            
            // Load translation history with enhanced styling
            async function loadTranslationHistory() {
                try {
                    const response = await axios.get('/api/translations');
                    const translations = response.data.translations;
                    
                    const historyList = document.getElementById('history-list');
                    const noHistory = document.getElementById('no-history');
                    historyList.innerHTML = '';
                    
                    if (translations.length === 0) {
                        noHistory.classList.remove('hidden');
                        return;
                    }
                    
                    noHistory.classList.add('hidden');
                    
                    translations.forEach((translation, index) => {
                        const item = document.createElement('div');
                        item.className = 'card p-4 hover:shadow-md transition-all duration-200 cursor-pointer';
                        item.style.animationDelay = (index * 0.1) + 's';
                        item.classList.add('animate-fade-in');
                        
                        const successRate = translation.total_keys > 0 ? 
                            Math.round(translation.translated_keys / translation.total_keys * 100) : 0;
                        
                        const date = new Date(translation.created_at).toLocaleDateString('es-ES', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        
                        // Success rate color
                        const rateColor = successRate >= 90 ? 'var(--chart-2)' : 
                                         successRate >= 70 ? 'var(--chart-3)' : 'var(--destructive)';
                        
                        item.innerHTML = \`
                            <div class="flex justify-between items-center">
                                <div class="flex-1">
                                    <div class="flex items-center gap-3 mb-2">
                                        <div class="flex items-center gap-2 font-medium" style="color: var(--card-foreground);">
                                            <i class="fas fa-exchange-alt" style="color: var(--primary);"></i>
                                            <span class="px-2 py-1 rounded text-xs" style="background-color: oklch(from var(--primary) l c h / 0.1); color: var(--primary);">
                                                \${translation.source_language}
                                            </span>
                                            <i class="fas fa-arrow-right text-xs opacity-50"></i>
                                            <span class="px-2 py-1 rounded text-xs" style="background-color: oklch(from var(--secondary) l c h / 0.1); color: var(--secondary);">
                                                \${translation.target_language}
                                            </span>
                                        </div>
                                        <div class="px-2 py-1 rounded text-xs font-semibold" style="background-color: oklch(from \${rateColor} l c h / 0.1); color: \${rateColor};">
                                            \${successRate}% éxito
                                        </div>
                                    </div>
                                    
                                    <div class="flex items-center gap-4 text-sm opacity-70" style="color: var(--card-foreground);">
                                        <span>
                                            <i class="fas fa-key mr-1"></i>
                                            \${translation.translated_keys}/\${translation.total_keys} claves
                                        </span>
                                        <span>
                                            <i class="fas fa-clock mr-1"></i>
                                            \${translation.processing_time_ms}ms
                                        </span>
                                        <span>
                                            <i class="fas fa-calendar mr-1"></i>
                                            \${date}
                                        </span>
                                    </div>
                                </div>
                                
                                <button onclick="viewTranslationDetails(\${translation.id})" 
                                        class="btn-secondary px-3 py-2 text-sm ml-4">
                                    <i class="fas fa-eye mr-1"></i>
                                    Ver
                                </button>
                            </div>
                        \`;
                        
                        historyList.appendChild(item);
                    });
                    
                } catch (error) {
                    console.error('Error loading history:', error);
                    const historyList = document.getElementById('history-list');
                    historyList.innerHTML = \`
                        <div class="text-center py-4 text-red-500">
                            <i class="fas fa-exclamation-triangle mr-2"></i>
                            Error al cargar el historial
                        </div>
                    \`;
                }
            }
            
            // View translation details with enhanced modal
            async function viewTranslationDetails(translationId) {
                try {
                    const response = await axios.get(\`/api/translations/\${translationId}/stats\`);
                    const data = response.data;
                    
                    // Create enhanced modal
                    const modal = document.createElement('div');
                    modal.className = 'fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4';
                    modal.style.backdropFilter = 'blur(4px)';
                    
                    const successRate = parseFloat(data.summary.successRate);
                    const rateColor = successRate >= 90 ? 'var(--chart-2)' : 
                                     successRate >= 70 ? 'var(--chart-3)' : 'var(--destructive)';
                    
                    modal.innerHTML = \`
                        <div class="card max-w-5xl w-full max-h-screen overflow-y-auto animate-slide-up" style="background-color: var(--card); border: 1px solid var(--border);">
                            <div class="p-6">
                                <div class="flex justify-between items-center mb-6">
                                    <h3 class="text-2xl font-bold" style="color: var(--card-foreground);">
                                        <i class="fas fa-chart-line mr-3" style="color: var(--primary);"></i>
                                        Detalles de Traducción
                                    </h3>
                                    <button onclick="this.parentElement.parentElement.parentElement.parentElement.remove()" 
                                            class="btn-secondary px-3 py-2">
                                        <i class="fas fa-times"></i>
                                    </button>
                                </div>
                                
                                <!-- Summary Stats -->
                                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                                    <div class="stat-time p-4 rounded-lg text-center">
                                        <div class="text-3xl font-bold">\${data.summary.totalKeys}</div>
                                        <div class="text-sm opacity-80">Total Claves</div>
                                    </div>
                                    <div class="stat-success p-4 rounded-lg text-center">
                                        <div class="text-3xl font-bold">\${data.summary.translatedKeys}</div>
                                        <div class="text-sm opacity-80">Exitosas</div>
                                    </div>
                                    <div class="stat-error p-4 rounded-lg text-center">
                                        <div class="text-3xl font-bold">\${data.summary.failedKeys}</div>
                                        <div class="text-sm opacity-80">Fallidas</div>
                                    </div>
                                    <div class="p-4 rounded-lg text-center" style="background-color: oklch(from \${rateColor} l c h / 0.1); color: \${rateColor}; border: 1px solid oklch(from \${rateColor} l c h / 0.2);">
                                        <div class="text-3xl font-bold">\${data.summary.successRate}%</div>
                                        <div class="text-sm opacity-80">Tasa Éxito</div>
                                    </div>
                                </div>
                                
                                <!-- Translation Info -->
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                                    <div class="card p-4" style="background-color: oklch(from var(--primary) l c h / 0.05); border: 1px solid oklch(from var(--primary) l c h / 0.1);">
                                        <h4 class="font-semibold mb-3" style="color: var(--primary);">
                                            <i class="fas fa-info-circle mr-2"></i>
                                            Información General
                                        </h4>
                                        <div class="space-y-2 text-sm">
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Idiomas:</span>
                                                <span class="font-medium">\${data.translation.source_language} → \${data.translation.target_language}</span>
                                            </div>
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Tiempo total:</span>
                                                <span class="font-medium">\${data.translation.processing_time_ms}ms</span>
                                            </div>
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Tiempo promedio:</span>
                                                <span class="font-medium">\${data.summary.averageTimePerKey}ms/clave</span>
                                            </div>
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Sesión:</span>
                                                <span class="font-mono text-xs">\${data.translation.session_id}</span>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div class="card p-4" style="background-color: oklch(from var(--chart-2) l c h / 0.05); border: 1px solid oklch(from var(--chart-2) l c h / 0.1);">
                                        <h4 class="font-semibold mb-3" style="color: var(--chart-2);">
                                            <i class="fas fa-tachometer-alt mr-2"></i>
                                            Métricas de Rendimiento
                                        </h4>
                                        <div class="space-y-2 text-sm">
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Velocidad:</span>
                                                <span class="font-medium">\${(data.summary.totalKeys / (data.translation.processing_time_ms / 1000)).toFixed(1)} claves/seg</span>
                                            </div>
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Eficiencia:</span>
                                                <span class="font-medium">\${data.summary.successRate}%</span>
                                            </div>
                                            <div class="flex justify-between">
                                                <span class="opacity-70">Fecha:</span>
                                                <span class="font-medium">\${new Date(data.translation.created_at).toLocaleDateString('es-ES', {
                                                    year: 'numeric',
                                                    month: 'short',
                                                    day: 'numeric',
                                                    hour: '2-digit',
                                                    minute: '2-digit'
                                                })}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Detailed breakdown -->
                                <div class="mb-6">
                                    <h4 class="text-lg font-semibold mb-4" style="color: var(--card-foreground);">
                                        <i class="fas fa-list-ul mr-2" style="color: var(--chart-3);"></i>
                                        Detalles por Clave (\${data.details.length} elementos)
                                    </h4>
                                    <div class="card max-h-80 overflow-y-auto" style="background-color: var(--input);">
                                        \${data.details.map(detail => \`
                                            <div class="flex justify-between items-start p-3 border-b border-opacity-20" style="border-color: var(--border);">
                                                <div class="flex-1 min-w-0">
                                                    <div class="font-mono text-sm font-semibold mb-1" style="color: var(--primary);">
                                                        \${detail.json_key}
                                                    </div>
                                                    <div class="text-xs opacity-70 mb-1 truncate" style="color: var(--foreground);">
                                                        <strong>Original:</strong> \${detail.original_value}
                                                    </div>
                                                    \${detail.translated_value ? \`
                                                        <div class="text-xs opacity-70 truncate" style="color: var(--foreground);">
                                                            <strong>Traducido:</strong> \${detail.translated_value}
                                                        </div>
                                                    \` : ''}
                                                </div>
                                                <div class="ml-4 flex flex-col items-end gap-1">
                                                    <span class="px-2 py-1 rounded text-xs font-medium \${detail.status === 'success' ? 'stat-success' : 'stat-error'}">
                                                        <i class="fas fa-\${detail.status === 'success' ? 'check' : 'times'} mr-1"></i>
                                                        \${detail.status}
                                                    </span>
                                                    \${detail.translation_time_ms ? \`
                                                        <span class="text-xs opacity-60" style="color: var(--foreground);">
                                                            \${detail.translation_time_ms}ms
                                                        </span>
                                                    \` : ''}
                                                </div>
                                            </div>
                                        \`).join('')}
                                    </div>
                                </div>
                                
                                <div class="text-center">
                                    <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                            class="btn-primary px-6 py-3">
                                        <i class="fas fa-check mr-2"></i>
                                        Cerrar
                                    </button>
                                </div>
                            </div>
                        </div>
                    \`;
                    
                    document.body.appendChild(modal);
                    
                    // Close on backdrop click
                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) {
                            modal.remove();
                        }
                    });
                    
                } catch (error) {
                    console.error('Error loading translation details:', error);
                    alert('Error al cargar los detalles de la traducción.');
                }
            }
        </script>
    </body>
    </html>
  `)
})

export default app