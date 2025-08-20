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

// Función auxiliar para traducir texto usando Cloudflare AI
async function translateText(ai: Ai, text: string, sourceLang: string, targetLang: string): Promise<string> {
  try {
    const response = await ai.run('@cf/meta/m2m100-1.2b', {
      text: text,
      source_lang: sourceLang === 'auto' ? undefined : sourceLang,
      target_lang: targetLang
    });
    
    return response.translated_text || text;
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Return original text if translation fails
  }
}

// Función recursiva para traducir objetos JSON
async function translateJsonObject(
  ai: Ai, 
  obj: any, 
  sourceLang: string, 
  targetLang: string, 
  details: any[], 
  translationId: number,
  path: string = ''
): Promise<any> {
  if (typeof obj === 'string') {
    const startTime = Date.now();
    try {
      const translated = await translateText(ai, obj, sourceLang, targetLang);
      const endTime = Date.now();
      
      details.push({
        translation_id: translationId,
        json_key: path,
        original_value: obj,
        translated_value: translated,
        status: 'success',
        translation_time_ms: endTime - startTime
      });
      
      return translated;
    } catch (error) {
      const endTime = Date.now();
      details.push({
        translation_id: translationId,
        json_key: path,
        original_value: obj,
        translated_value: null,
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        translation_time_ms: endTime - startTime
      });
      return obj; // Return original on error
    }
  } else if (Array.isArray(obj)) {
    const result = [];
    for (let i = 0; i < obj.length; i++) {
      result[i] = await translateJsonObject(ai, obj[i], sourceLang, targetLang, details, translationId, `${path}[${i}]`);
    }
    return result;
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      result[key] = await translateJsonObject(ai, value, sourceLang, targetLang, details, translationId, currentPath);
    }
    return result;
  }
  
  return obj; // Return primitive values unchanged (numbers, booleans, null)
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
  
  try {
    // Parse JSON if it's a string
    const parsedJson = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    
    // Count total keys
    const totalKeys = countStringKeys(parsedJson);
    
    // Create translation record
    const translationResult = await env.DB.prepare(`
      INSERT INTO translations (session_id, source_language, target_language, original_json, translated_json, total_keys, translated_keys, failed_keys, processing_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(sessionId, sourceLang, targetLang, JSON.stringify(parsedJson), '', totalKeys, 0, 0, 0).run();
    
    const translationId = translationResult.meta.last_row_id;
    
    // Translate JSON object
    const details: any[] = [];
    const translatedJson = await translateJsonObject(env.AI, parsedJson, sourceLang, targetLang, details, translationId);
    
    const endTime = Date.now();
    const processingTime = endTime - startTime;
    
    // Count successful and failed translations
    const successCount = details.filter(d => d.status === 'success').length;
    const failedCount = details.filter(d => d.status === 'failed').length;
    
    // Update translation record with results
    await env.DB.prepare(`
      UPDATE translations 
      SET translated_json = ?, translated_keys = ?, failed_keys = ?, processing_time_ms = ?
      WHERE id = ?
    `).bind(JSON.stringify(translatedJson), successCount, failedCount, processingTime, translationId).run();
    
    // Insert translation details
    for (const detail of details) {
      await env.DB.prepare(`
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
      ).run();
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
        processingTimeMs: processingTime,
        averageTimePerKey: totalKeys > 0 ? processingTime / totalKeys : 0
      },
      details
    });
    
  } catch (error) {
    console.error('Translation error:', error);
    return c.json({ 
      error: 'Translation failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
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
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Traductor de JSON</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
            .file-drop-zone {
                border: 2px dashed #cbd5e0;
                transition: all 0.3s ease;
            }
            .file-drop-zone.dragover {
                border-color: #4299e1;
                background-color: #ebf8ff;
            }
            .json-editor {
                font-family: 'Courier New', monospace;
            }
        </style>
    </head>
    <body class="bg-gray-50 min-h-screen">
        <div class="container mx-auto px-4 py-8">
            <div class="max-w-6xl mx-auto">
                <!-- Header -->
                <div class="text-center mb-8">
                    <h1 class="text-4xl font-bold text-gray-900 mb-2">
                        <i class="fas fa-language mr-3 text-blue-500"></i>
                        Traductor de Documentos JSON
                    </h1>
                    <p class="text-gray-600">Traduce archivos JSON completos manteniendo su estructura original</p>
                </div>
                
                <!-- Main Content -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <!-- Left Panel: Upload and Configuration -->
                    <div class="space-y-6">
                        <!-- File Upload -->
                        <div class="bg-white rounded-lg shadow p-6">
                            <h2 class="text-xl font-semibold text-gray-900 mb-4">
                                <i class="fas fa-upload mr-2"></i>
                                Cargar JSON
                            </h2>
                            
                            <div id="drop-zone" class="file-drop-zone rounded-lg p-8 text-center cursor-pointer">
                                <i class="fas fa-cloud-upload-alt text-4xl text-gray-400 mb-4"></i>
                                <p class="text-gray-600 mb-2">Arrastra y suelta tu archivo JSON aquí</p>
                                <p class="text-sm text-gray-500 mb-4">o haz clic para seleccionar</p>
                                <input type="file" id="file-input" accept=".json" class="hidden">
                                <button onclick="document.getElementById('file-input').click()" 
                                        class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors">
                                    Seleccionar Archivo
                                </button>
                            </div>
                            
                            <!-- JSON Editor -->
                            <div class="mt-4">
                                <label class="block text-sm font-medium text-gray-700 mb-2">
                                    O pega tu JSON aquí:
                                </label>
                                <textarea id="json-input" 
                                         class="json-editor w-full h-32 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
                                         placeholder='{"key": "value", "greeting": "Hello World"}'></textarea>
                            </div>
                        </div>
                        
                        <!-- Language Selection -->
                        <div class="bg-white rounded-lg shadow p-6">
                            <h2 class="text-xl font-semibold text-gray-900 mb-4">
                                <i class="fas fa-globe mr-2"></i>
                                Configuración de Idiomas
                            </h2>
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">Idioma Origen</label>
                                    <select id="source-lang" class="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                        <option value="auto">Detectar automáticamente</option>
                                    </select>
                                </div>
                                
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">Idioma Destino *</label>
                                    <select id="target-lang" class="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                        <option value="">Seleccionar idioma...</option>
                                    </select>
                                </div>
                            </div>
                            
                            <button id="translate-btn" 
                                    class="w-full mt-4 bg-green-500 text-white py-3 px-6 rounded-lg hover:bg-green-600 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                                <i class="fas fa-magic mr-2"></i>
                                Traducir JSON
                            </button>
                        </div>
                    </div>
                    
                    <!-- Right Panel: Results and Statistics -->
                    <div class="space-y-6">
                        <!-- Translation Progress -->
                        <div id="progress-panel" class="bg-white rounded-lg shadow p-6 hidden">
                            <h2 class="text-xl font-semibold text-gray-900 mb-4">
                                <i class="fas fa-cogs mr-2"></i>
                                Progreso de Traducción
                            </h2>
                            
                            <div class="mb-4">
                                <div class="flex justify-between text-sm text-gray-600 mb-2">
                                    <span>Procesando...</span>
                                    <span id="progress-text">0%</span>
                                </div>
                                <div class="w-full bg-gray-200 rounded-full h-2">
                                    <div id="progress-bar" class="bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Statistics -->
                        <div id="stats-panel" class="bg-white rounded-lg shadow p-6 hidden">
                            <h2 class="text-xl font-semibold text-gray-900 mb-4">
                                <i class="fas fa-chart-bar mr-2"></i>
                                Estadísticas de Traducción
                            </h2>
                            
                            <div class="grid grid-cols-2 gap-4 mb-4">
                                <div class="bg-green-50 p-3 rounded-lg">
                                    <div class="text-2xl font-bold text-green-600" id="translated-count">0</div>
                                    <div class="text-sm text-green-700">Claves Traducidas</div>
                                </div>
                                
                                <div class="bg-red-50 p-3 rounded-lg">
                                    <div class="text-2xl font-bold text-red-600" id="failed-count">0</div>
                                    <div class="text-sm text-red-700">Fallos</div>
                                </div>
                                
                                <div class="bg-blue-50 p-3 rounded-lg">
                                    <div class="text-2xl font-bold text-blue-600" id="total-time">0ms</div>
                                    <div class="text-sm text-blue-700">Tiempo Total</div>
                                </div>
                                
                                <div class="bg-purple-50 p-3 rounded-lg">
                                    <div class="text-2xl font-bold text-purple-600" id="avg-time">0ms</div>
                                    <div class="text-sm text-purple-700">Tiempo Promedio</div>
                                </div>
                            </div>
                            
                            <div class="mb-4">
                                <div class="text-sm text-gray-600 mb-2">Tasa de Éxito</div>
                                <div class="w-full bg-gray-200 rounded-full h-3">
                                    <div id="success-rate-bar" class="bg-green-500 h-3 rounded-full" style="width: 0%"></div>
                                </div>
                                <div class="text-right text-sm text-gray-600 mt-1" id="success-rate-text">0%</div>
                            </div>
                        </div>
                        
                        <!-- Result JSON -->
                        <div id="result-panel" class="bg-white rounded-lg shadow p-6 hidden">
                            <div class="flex justify-between items-center mb-4">
                                <h2 class="text-xl font-semibold text-gray-900">
                                    <i class="fas fa-file-code mr-2"></i>
                                    JSON Traducido
                                </h2>
                                <button id="download-btn" 
                                        class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors">
                                    <i class="fas fa-download mr-2"></i>
                                    Descargar
                                </button>
                            </div>
                            
                            <textarea id="result-json" 
                                     class="json-editor w-full h-64 p-3 border border-gray-300 rounded-lg bg-gray-50" 
                                     readonly></textarea>
                        </div>
                        
                        <!-- Translation History -->
                        <div class="bg-white rounded-lg shadow p-6">
                            <div class="flex justify-between items-center mb-4">
                                <h2 class="text-xl font-semibold text-gray-900">
                                    <i class="fas fa-history mr-2"></i>
                                    Historial de Traducciones
                                </h2>
                                <button id="refresh-history-btn" 
                                        class="bg-gray-500 text-white px-3 py-1 rounded text-sm hover:bg-gray-600 transition-colors">
                                    <i class="fas fa-sync-alt mr-1"></i>
                                    Actualizar
                                </button>
                            </div>
                            
                            <div id="history-list" class="space-y-2">
                                <!-- History items will be loaded here -->
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            let currentTranslation = null;
            
            // Initialize app
            document.addEventListener('DOMContentLoaded', function() {
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
            
            // Translate JSON
            async function translateJSON() {
                const jsonInput = document.getElementById('json-input').value;
                const sourceLang = document.getElementById('source-lang').value;
                const targetLang = document.getElementById('target-lang').value;
                
                if (!jsonInput.trim()) {
                    alert('Por favor ingresa o carga un archivo JSON.');
                    return;
                }
                
                if (!targetLang) {
                    alert('Por favor selecciona un idioma destino.');
                    return;
                }
                
                try {
                    JSON.parse(jsonInput); // Validate JSON
                } catch (error) {
                    alert('El JSON no es válido. Por favor revisa la sintaxis.');
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
                    displayTranslationResults(currentTranslation);
                    hideProgressPanel();
                    loadTranslationHistory();
                    
                } catch (error) {
                    console.error('Translation error:', error);
                    alert('Error durante la traducción: ' + (error.response?.data?.message || error.message));
                    hideProgressPanel();
                }
            }
            
            // Show/hide progress panel
            function showProgressPanel() {
                document.getElementById('progress-panel').classList.remove('hidden');
                document.getElementById('translate-btn').disabled = true;
                
                // Simulate progress (since we don't have real-time updates)
                let progress = 0;
                const interval = setInterval(() => {
                    progress += Math.random() * 15;
                    if (progress > 90) progress = 90;
                    
                    document.getElementById('progress-bar').style.width = progress + '%';
                    document.getElementById('progress-text').textContent = Math.round(progress) + '%';
                }, 500);
                
                // Store interval to clear it later
                window.progressInterval = interval;
            }
            
            function hideProgressPanel() {
                if (window.progressInterval) {
                    clearInterval(window.progressInterval);
                }
                
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-text').textContent = '100%';
                
                setTimeout(() => {
                    document.getElementById('progress-panel').classList.add('hidden');
                    document.getElementById('translate-btn').disabled = false;
                }, 500);
            }
            
            // Display translation results
            function displayTranslationResults(data) {
                const stats = data.statistics;
                
                // Update statistics
                document.getElementById('translated-count').textContent = stats.translatedKeys;
                document.getElementById('failed-count').textContent = stats.failedKeys;
                document.getElementById('total-time').textContent = stats.processingTimeMs + 'ms';
                document.getElementById('avg-time').textContent = Math.round(stats.averageTimePerKey) + 'ms';
                
                // Update success rate
                const successRate = stats.totalKeys > 0 ? (stats.translatedKeys / stats.totalKeys * 100) : 0;
                document.getElementById('success-rate-bar').style.width = successRate + '%';
                document.getElementById('success-rate-text').textContent = Math.round(successRate) + '%';
                
                // Show translated JSON
                document.getElementById('result-json').value = JSON.stringify(data.translatedJson, null, 2);
                
                // Show panels
                document.getElementById('stats-panel').classList.remove('hidden');
                document.getElementById('result-panel').classList.remove('hidden');
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
            
            // Load translation history
            async function loadTranslationHistory() {
                try {
                    const response = await axios.get('/api/translations');
                    const translations = response.data.translations;
                    
                    const historyList = document.getElementById('history-list');
                    historyList.innerHTML = '';
                    
                    if (translations.length === 0) {
                        historyList.innerHTML = '<p class="text-gray-500 text-center py-4">No hay traducciones aún</p>';
                        return;
                    }
                    
                    translations.forEach(translation => {
                        const item = document.createElement('div');
                        item.className = 'flex justify-between items-center p-3 bg-gray-50 rounded-lg';
                        
                        const successRate = translation.total_keys > 0 ? 
                            Math.round(translation.translated_keys / translation.total_keys * 100) : 0;
                        
                        const date = new Date(translation.created_at).toLocaleDateString('es-ES', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        
                        item.innerHTML = \`
                            <div>
                                <div class="font-medium">\${translation.source_language} → \${translation.target_language}</div>
                                <div class="text-sm text-gray-600">
                                    \${translation.translated_keys}/\${translation.total_keys} claves • \${successRate}% éxito • \${date}
                                </div>
                            </div>
                            <button onclick="viewTranslationDetails(\${translation.id})" 
                                    class="text-blue-500 hover:text-blue-700">
                                <i class="fas fa-eye"></i>
                            </button>
                        \`;
                        
                        historyList.appendChild(item);
                    });
                    
                } catch (error) {
                    console.error('Error loading history:', error);
                }
            }
            
            // View translation details
            async function viewTranslationDetails(translationId) {
                try {
                    const response = await axios.get(\`/api/translations/\${translationId}/stats\`);
                    const data = response.data;
                    
                    // Create modal or detailed view
                    const modal = document.createElement('div');
                    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
                    modal.innerHTML = \`
                        <div class="bg-white rounded-lg p-6 max-w-4xl w-full mx-4 max-h-screen overflow-y-auto">
                            <div class="flex justify-between items-center mb-4">
                                <h3 class="text-xl font-bold">Detalles de Traducción</h3>
                                <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                        class="text-gray-500 hover:text-gray-700">
                                    <i class="fas fa-times"></i>
                                </button>
                            </div>
                            
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                                <div class="bg-blue-50 p-3 rounded">
                                    <div class="font-bold text-blue-600">\${data.summary.totalKeys}</div>
                                    <div class="text-sm">Total Claves</div>
                                </div>
                                <div class="bg-green-50 p-3 rounded">
                                    <div class="font-bold text-green-600">\${data.summary.translatedKeys}</div>
                                    <div class="text-sm">Exitosas</div>
                                </div>
                                <div class="bg-red-50 p-3 rounded">
                                    <div class="font-bold text-red-600">\${data.summary.failedKeys}</div>
                                    <div class="text-sm">Fallidas</div>
                                </div>
                                <div class="bg-purple-50 p-3 rounded">
                                    <div class="font-bold text-purple-600">\${data.summary.successRate}%</div>
                                    <div class="text-sm">Tasa Éxito</div>
                                </div>
                            </div>
                            
                            <div class="mb-4">
                                <h4 class="font-semibold mb-2">Detalles por Clave</h4>
                                <div class="max-h-64 overflow-y-auto">
                                    \${data.details.map(detail => \`
                                        <div class="flex justify-between items-center p-2 border-b">
                                            <div class="flex-1 truncate">
                                                <div class="font-mono text-sm">\${detail.json_key}</div>
                                                <div class="text-xs text-gray-500">\${detail.original_value}</div>
                                            </div>
                                            <div class="ml-2">
                                                <span class="px-2 py-1 rounded text-xs \${detail.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                                                    \${detail.status}
                                                </span>
                                            </div>
                                        </div>
                                    \`).join('')}
                                </div>
                            </div>
                        </div>
                    \`;
                    
                    document.body.appendChild(modal);
                    
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