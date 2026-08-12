/**
 * PUDU Flashbot Pro WhatsApp Arrival Notification Module
 * Standalone Node.js 24 Server with Meta WhatsApp Cloud API & PUDU Open Platform Webhook Listener
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3001;

// ============================================================================
// IN-MEMORY RUNTIME STATE & CONFIGURATION
// ============================================================================
let settings = {
  apiVersion: "v19.0",
  phoneNumberId: "YOUR_META_PHONE_NUMBER_ID",
  accessToken: "YOUR_META_ACCESS_TOKEN",
  wabaId: "YOUR_WHATSAPP_BUSINESS_ACCOUNT_ID",
  useMockMode: true, // Default to Developer Mock Mode for zero-cost instant testing
  whatsappTemplateText: `*PUDU Flashbot Pro Arrival Notification*

Hello {{recipient_name}},

Your delivery item has arrived at *{{destination}}*.

Unlock Details:
• Storage Box: Compartment #{{compartment_no}}
• Unlock Method: Enter 4-Digit PIN *{{passcode}}* OR tap your NFC Card on the robot screen.

Please collect your item promptly so Flashbot Pro can proceed to its next task.

Thank you.`,
};

let activeTasks = [
  {
    taskId: "TASK-8901",
    robotSn: "FB-PRO-98421",
    destination: "Room 302 (Finance)",
    recipientName: "Alice Tan",
    recipientPhone: "+60123456789",
    compartmentNo: 2,
    passcode: "4921",
    nfcCardId: "NFC-CARD-8842",
    status: "EN_ROUTE", // EN_ROUTE | ARRIVED | CABINET_OPENED | COMPLETED | CANCELLED
    notificationSent: false,
    createdAt: new Date(Date.now() - 300000).toISOString(),
    arrivedAt: null,
  },
  {
    taskId: "TASK-8902",
    robotSn: "FB-PRO-98421",
    destination: "Executive Office A",
    recipientName: "David Wong",
    recipientPhone: "+6591234567",
    compartmentNo: 1,
    passcode: "8103",
    nfcCardId: "NFC-CARD-1092",
    status: "EN_ROUTE",
    notificationSent: false,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    arrivedAt: null,
  }
];

let auditLogs = [
  {
    id: "LOG-101",
    timestamp: new Date(Date.now() - 300000).toISOString(),
    eventType: "TASK_CREATED",
    taskId: "TASK-8901",
    details: "Delivery task created for Room 302 (Compartment #2, PIN: 4921)",
  }
];

// Server-Sent Events (SSE) Clients
let sseClients = [];

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(message);
    } catch (e) {
      // client disconnected
    }
  });
}

function addAuditLog(eventType, taskId, details, payload = null) {
  const log = {
    id: `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    eventType,
    taskId,
    details,
    payload,
  };
  auditLogs.unshift(log);
  if (auditLogs.length > 100) auditLogs = auditLogs.slice(0, 100);
  return log;
}

// ============================================================================
// META WHATSAPP CLOUD API INTEGRATION CLIENT
// ============================================================================
async function sendWhatsAppMessage({ recipientPhone, messageText }) {
  const timestamp = new Date().toISOString();
  const cleanPhone = recipientPhone.replace(/[^0-9]/g, '');

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleanPhone,
    type: "text",
    text: {
      preview_url: false,
      body: messageText
    }
  };

  const isMock = settings.useMockMode || 
                 !settings.phoneNumberId || 
                 settings.phoneNumberId.includes("YOUR_META") ||
                 !settings.accessToken || 
                 settings.accessToken.includes("YOUR_META");

  if (isMock) {
    console.log(`\n================== [MOCK WHATSAPP DISPATCH] ==================`);
    console.log(`📱 Recipient Phone: +${cleanPhone}`);
    console.log(`💬 Message Text:\n${messageText}`);
    console.log(`==============================================================\n`);

    return {
      success: true,
      mode: "MOCK_DEVELOPER_MODE",
      messageId: `wamid.MOCK_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      to: cleanPhone,
      text: messageText,
      timestamp,
      detail: "Dispatched successfully via Developer Mock Mode (Zero charges incurred)."
    };
  }

  // Official Meta WhatsApp Business Cloud API Call
  try {
    const url = `https://graph.facebook.com/${settings.apiVersion || 'v19.0'}/${settings.phoneNumberId}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const resData = await response.json();

    if (!response.ok) {
      throw new Error(resData.error?.message || `HTTP ${response.status}`);
    }

    return {
      success: true,
      mode: "META_CLOUD_API",
      messageId: resData.messages?.[0]?.id || `wamid.${Date.now()}`,
      to: cleanPhone,
      text: messageText,
      metaResponse: resData,
      timestamp,
      detail: "Successfully delivered via Meta WhatsApp Business Cloud API."
    };
  } catch (err) {
    console.error('[META WHATSAPP API ERROR]', err.message);
    return {
      success: false,
      mode: "META_CLOUD_API",
      error: err.message,
      timestamp,
      detail: `Failed to send via Meta WhatsApp API: ${err.message}`
    };
  }
}

// ============================================================================
// HTTP ROUTER & SERVER
// ============================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // Helper to send JSON responses
  const sendJSON = (data, statusCode = 200) => {
    res.writeHead(statusCode, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };

  // Helper to parse JSON body
  const getRequestBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });

  // Enable CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // SSE Stream Endpoint
  if (pathname === '/api/v1/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // GET Settings
  if (pathname === '/api/v1/settings' && method === 'GET') {
    return sendJSON({ success: true, settings });
  }

  // POST Settings
  if (pathname === '/api/v1/settings' && method === 'POST') {
    const body = await getRequestBody();
    settings = { ...settings, ...body };
    addAuditLog("SETTINGS_UPDATED", "SYSTEM", "WhatsApp API credentials / message template updated.");
    broadcastSSE("settings_updated", settings);
    return sendJSON({ success: true, settings });
  }

  // GET Tasks & Logs
  if (pathname === '/api/v1/tasks' && method === 'GET') {
    return sendJSON({
      success: true,
      tasks: activeTasks,
      logs: auditLogs,
    });
  }

  // POST Create Delivery Task
  if (pathname === '/api/v1/tasks' && method === 'POST') {
    const body = await getRequestBody();
    const newTask = {
      taskId: body.taskId || `TASK-${Math.floor(1000 + Math.random() * 9000)}`,
      robotSn: body.robotSn || "FB-PRO-98421",
      destination: body.destination || "Room 101",
      recipientName: body.recipientName || "Valued Recipient",
      recipientPhone: body.recipientPhone || "+60123456789",
      compartmentNo: parseInt(body.compartmentNo) || 1,
      passcode: body.passcode || Math.floor(1000 + Math.random() * 9000).toString(),
      nfcCardId: body.nfcCardId || `NFC-CARD-${Math.floor(1000 + Math.random() * 9000)}`,
      status: "EN_ROUTE",
      notificationSent: false,
      createdAt: new Date().toISOString(),
      arrivedAt: null,
    };

    activeTasks.unshift(newTask);
    addAuditLog("TASK_CREATED", newTask.taskId, `Task created for ${newTask.destination} (${newTask.recipientName})`);
    broadcastSSE("task_created", newTask);
    return sendJSON({ success: true, task: newTask });
  }

  // ==========================================================================
  // PUDU OPEN PLATFORM WEBHOOK LISTENER
  // POST /api/v1/pudu/webhook
  // ==========================================================================
  if (pathname === '/api/v1/pudu/webhook' && method === 'POST') {
    const payload = await getRequestBody();
    console.log('[PUDU WEBHOOK RECEIVED]', JSON.stringify(payload, null, 2));

    const robotSn = payload.robot_sn || payload.robot_id || payload.device_id || "FB-PRO-98421";
    const taskId = payload.task_id || payload.data?.task_id;
    const status = payload.status || payload.data?.status || "ARRIVED";
    const destination = payload.destination || payload.data?.destination || payload.data?.target_point;

    addAuditLog("WEBHOOK_RECEIVED", taskId || "UNKNOWN_TASK", `PUDU Robot (${robotSn}) event: ${status} at ${destination || 'destination'}`, payload);

    // Find active task
    let task = activeTasks.find(t => (taskId && t.taskId === taskId) || (destination && t.destination === destination));

    if (!task) {
      task = {
        taskId: taskId || `TASK-AUTO-${Math.floor(Math.random() * 1000)}`,
        robotSn,
        destination: destination || "Specified Room",
        recipientName: "Valued Recipient",
        recipientPhone: "+60123456789",
        compartmentNo: payload.compartment_no || 1,
        passcode: payload.passcode || "1234",
        nfcCardId: "NFC-CARD-8842",
        status: "EN_ROUTE",
        notificationSent: false,
        createdAt: new Date().toISOString(),
      };
      activeTasks.unshift(task);
    }

    // Update status
    task.status = status;
    if (status === 'ARRIVED') task.arrivedAt = new Date().toISOString();

    let whatsappResult = null;

    // IF STATUS IS ARRIVED -> DISPATCH WHATSAPP NOTIFICATION!
    if (status === "ARRIVED" || status === "TASK_ARRIVED") {
      let messageText = settings.whatsappTemplateText || "";
      messageText = messageText
        .replace(/{{recipient_name}}/g, task.recipientName || "Valued Recipient")
        .replace(/{{destination}}/g, task.destination || "Destination")
        .replace(/{{compartment_no}}/g, task.compartmentNo || "1")
        .replace(/{{passcode}}/g, task.passcode || "0000")
        .replace(/{{nfc_id}}/g, task.nfcCardId || "NFC-TAG")
        .replace(/{{robot_sn}}/g, task.robotSn || "PUDU Flashbot Pro");

      whatsappResult = await sendWhatsAppMessage({
        recipientPhone: task.recipientPhone,
        messageText,
      });

      task.notificationSent = whatsappResult.success;
      addAuditLog(
        whatsappResult.success ? "WHATSAPP_SENT" : "WHATSAPP_FAILED",
        task.taskId,
        `WhatsApp alert to ${task.recipientPhone}: ${whatsappResult.detail}`,
        whatsappResult
      );
    } else {
      addAuditLog(`STATUS_${status}`, task.taskId, `Robot status updated to ${status}`);
    }

    broadcastSSE("pudu_event", { task, status, whatsappResult });

    return sendJSON({
      code: 0,
      msg: "success",
      data: {
        taskId: task.taskId,
        status,
        notificationTriggered: !!whatsappResult,
        whatsappSuccess: whatsappResult ? whatsappResult.success : false
      }
    });
  }

  // POST Simulator Trigger
  if (pathname === '/api/v1/simulator/trigger' && method === 'POST') {
    const body = await getRequestBody();
    const task = activeTasks.find(t => t.taskId === body.taskId) || activeTasks[0];

    const simulatedPayload = {
      event_type: "task_status_changed",
      robot_sn: task ? task.robotSn : "FB-PRO-98421",
      task_id: task ? task.taskId : "TASK-8901",
      status: body.status || "ARRIVED",
      destination: task ? task.destination : "Room 302",
      compartment_no: task ? task.compartmentNo : 2,
      passcode: task ? task.passcode : "4921",
      timestamp: Date.now()
    };

    // Re-route internally to webhook processor
    const localReq = await fetch(`http://localhost:${PORT}/api/v1/pudu/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simulatedPayload)
    });
    const data = await localReq.json();
    return sendJSON(data);
  }

  // Serve Public Static Assets (Web Dashboard UI)
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/html' });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n==================================================================`);
  console.log(`PUDU Flashbot Pro WhatsApp Notification Server Active!`);
  console.log(`Dashboard UI:      http://localhost:${PORT}`);
  console.log(`PUDU Webhook URL:  http://localhost:${PORT}/api/v1/pudu/webhook`);
  console.log(`==================================================================\n`);
});
