// ═══════════════════════════════════════════════════════════════════════
//  Palomma Waitlist — API de recepción de leads
//  Vercel Serverless Function: /api/submit
//
//  Variables de entorno requeridas (configura en Vercel → Settings → Env):
//    GOOGLE_SERVICE_ACCOUNT_EMAIL  →  email de la cuenta de servicio
//    GOOGLE_PRIVATE_KEY            →  clave privada (incluye los \n)
//    GOOGLE_SHEET_ID               →  ID del Google Sheet (en la URL)
//
//  Integraciones opcionales (actívalas agregando la variable en Vercel):
//    MAKE_WEBHOOK_URL    →  webhook de Make/Integromat
//    SLACK_WEBHOOK_URL   →  webhook de Slack (Incoming Webhooks)
// ═══════════════════════════════════════════════════════════════════════

const { google } = require('googleapis');

// ─── 1. GOOGLE SHEETS ────────────────────────────────────────────────
async function appendToGoogleSheets(data) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Columnas del sheet (en orden):
  // A: Fecha | B: Prioridad | C: Tipo persona | D: Empresa/Nombre
  // E: NIT/CC | F: Rep legal | G: CC rep legal | H: Ciudad | I: Celular
  // J: Software ERP | K: Métodos recaudo | L: Pasarela | M: Otro recaudo
  // N: Contratos | O: Contratos exactos
  const row = [
    data.fecha_solicitud,
    data.prioridad,
    data.tipo_persona,
    data.razon_social || data.nombre_natural || '',
    data.nit || data.doc_natural || '',
    data.nombre_rep_legal || '',
    data.doc_rep_legal || '',
    data.ciudad,
    data.celular,
    data.software_erp,
    data.metodos_recaudo,
    data.cual_pasarela || '',
    data.cual_otro_recaudo || '',
    data.num_contratos,
    data.contratos_exactos || '',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Waitlist!A:O',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ─── 2. MAKE / INTEGROMAT ────────────────────────────────────────────
// Para activar: agrega MAKE_WEBHOOK_URL en las env vars de Vercel
async function notifyMake(data) {
  if (!process.env.MAKE_WEBHOOK_URL) return;
  await fetch(process.env.MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ─── 3. SLACK ────────────────────────────────────────────────────────
// Para activar: agrega SLACK_WEBHOOK_URL en las env vars de Vercel
async function notifySlack(data) {
  if (!process.env.SLACK_WEBHOOK_URL) return;

  const nombre = data.razon_social || data.nombre_natural || 'Sin nombre';
  const emoji  = data.prioridad === 'ALTA' ? '🔥' : '📋';

  const message = {
    text: `${emoji} *Nuevo lead en waitlist de Palomma Pay*`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} Nuevo lead — ${data.prioridad}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Empresa/Nombre*\n${nombre}` },
          { type: 'mrkdwn', text: `*Tipo*\n${data.tipo_persona}` },
          { type: 'mrkdwn', text: `*Ciudad*\n${data.ciudad}` },
          { type: 'mrkdwn', text: `*Celular*\n${data.celular}` },
          { type: 'mrkdwn', text: `*Contratos*\n${data.num_contratos}${data.contratos_exactos ? ` (${data.contratos_exactos} exactos)` : ''}` },
          { type: 'mrkdwn', text: `*Software ERP*\n${data.software_erp}` },
          { type: 'mrkdwn', text: `*Recaudo actual*\n${data.metodos_recaudo}${data.cual_pasarela ? ` · ${data.cual_pasarela}` : ''}` },
          { type: 'mrkdwn', text: `*Fecha*\n${data.fecha_solicitud}` },
        ],
      },
    ],
  };

  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const data = req.body;

    if (!data || !data.celular) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // Promise.allSettled: si una integración falla, las demás igual corren
    const results = await Promise.allSettled([
      appendToGoogleSheets(data),
      notifyMake(data),
      notifySlack(data),
    ]);

    // Log de errores por integración (visible en Vercel → Functions logs)
    results.forEach((result, i) => {
      const names = ['Google Sheets', 'Make', 'Slack'];
      if (result.status === 'rejected') {
        console.error(`[${names[i]}] Error:`, result.reason?.message || result.reason);
      }
    });

    // Si Sheets falló, devolvemos error (es la integración principal)
    if (results[0].status === 'rejected') throw results[0].reason;

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[/api/submit] Error general:', err?.message || err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
