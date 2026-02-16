/**
 * 微信自动抢红包脚本 v7
 * AutoJS 6 专用
 *
 * v7 新增：
 *  - 双层扫描：主页聊天列表 → 发现含红包的会话 → 点进去 → 扫聊天内红包 → 抢
 *  - 点击红包后 TAP_DELAY ms 立即点屏幕中间
 *  - 无截图，纯节点判断
 *  - 通知栏监听
 */

auto();

// ==================== Console ====================
console.show();
console.setSize(device.width * 0.92, 400);
console.setPosition(device.width * 0.04, 50);
console.setTitle("🧧 微信抢红包 v7");
console.setTitleTextColor("#FFFFFF");
console.setTitleBackgroundColor("#07C160");

// ==================== 配置 ====================
var pkg = "com.tencent.mm";

var CONFIG = {
  launchWait:   3000,
  scanInterval: 200,
  rpTimeout:    5000,
  backWaitTime: 500,
  TAP_DELAY:    100,    // 点红包后多久点屏幕中间(ms)
  TAP_CENTER_Y: 0.62,  // 红包"开"按钮 Y 轴比例
  debugLog:     true,
};

// ==================== 关键词 ====================
var KW = {
  // 聊天内红包消息
  rpText:    "微信红包",
  // 主页会话列表副标题（摘要行）含红包的标志
  // 微信主页会话列表：未读时摘要可能是"[微信红包]"或"微信红包"
  rpSummary: ["[微信红包]", "微信红包"],
  // 已领取判断
  rpGrabbed: "已领取",
  rpOpened:  "已被领完",
  // 弹窗状态
  rpDetail:  "红包详情",
  rpEmpty:   ["手慢了", "已被领完", "已领完", "来晚了", "查看领取详情"],
  descBack:  "返回",
  descSearch:"搜索",
};

// ==================== 全局状态 ====================
var lastRPid          = "";
var lastSessionId     = "";   // 记录上次处理的会话，避免重复进入
var totalGrabbed      = 0;
var totalMissed       = 0;
var startTime         = new Date().getTime();
var notificationQueue = [];

// ==================== 通知监听 ====================
function setupNotificationListener() {
  try {
    setDefaultNotificationHandler(function(notification) {
      try {
        var pkgName = notification.getPackageName ? notification.getPackageName() : "";
        if (pkgName !== pkg) return;
        var content = ((notification.getTitle ? notification.getTitle() : "") + " " +
                       (notification.getText  ? notification.getText()  : "")) + "";
        if (content.indexOf("红包") !== -1) {
          clog("info", "🔔 通知含红包: " + content.substring(0, 35));
          notificationQueue.push(notification);
        }
      } catch(e) { debugLog("通知异常: " + e); }
    });
    clog("ok", "通知监听已启动 ✓");
  } catch(e) {
    clog("warn", "通知监听失败（需通知权限）: " + e);
  }
}

// ==================== 主入口 ====================
main();

function main() {
  clog("info", "=== 微信抢红包 v7 启动 ===");
  clog("info", "时间: " + new Date().toLocaleString());
  clog("info", "设备: " + device.brand + " " + device.model);
  clog("info", "屏幕: " + device.width + "x" + device.height);
  clog("info", "------------------------------");

  if (!checkAccessibility()) {
    clog("error", "无障碍服务未开启！"); toast("请先开启！"); exit(); return;
  }
  clog("ok", "无障碍服务 ✓");

  setupNotificationListener();

  clog("info", "正在启动微信...");
  if (!app.launch(pkg)) {
    clog("error", "微信启动失败！"); toast("微信启动失败"); exit(); return;
  }
  sleep(CONFIG.launchWait);
  clog("ok", "微信已启动，开始扫描...");
  clog("info", "------------------------------");
  toast("抢红包脚本运行中");

  scanLoop();
}

// ==================== 主扫描循环 ====================
function scanLoop() {
  while (!isStopped()) {
    try {

      // 1. 优先处理通知队列
      if (notificationQueue.length > 0) {
        handleNotificationRP(notificationQueue.shift());
        sleep(CONFIG.scanInterval);
        continue;
      }

      if (currentPackage() !== pkg) {
        debugLog("⏳ 等待微信...");
        sleep(600);
        continue;
      }

      // 2. 判断当前在哪个界面，分别处理
      if (isAtMainPage()) {
        // ── 主页：扫会话列表找含红包的会话 ──
        scanMainPageForRP();
      } else {
        // ── 聊天内：扫红包消息 ──
        scanChatForRP();
      }

    } catch(e) {
      clog("error", "异常: " + (e.message || e));
    }

    sleep(CONFIG.scanInterval);
  }

  printSummary();
}

// ==================== 判断是否在微信主页（会话列表）====================
function isAtMainPage() {
  // 主页特征：搜索按钮存在，且没有"返回"按钮
  return desc(KW.descSearch).exists() && !desc(KW.descBack).exists();
}

// ==================== 扫主页会话列表 ====================
function scanMainPageForRP() {
  // 找所有副标题 TextView，检查是否含红包关键词
  // 微信主页会话列表结构：每行一个 clickable 的大节点
  //   ├─ 头像 ImageView
  //   ├─ 联系人名 TextView
  //   ├─ 摘要 TextView  ← 这里会显示"[微信红包]"
  //   └─ 时间 TextView

  var sessionNode = findRPSession();
  if (!sessionNode) {
    debugLog("📋 主页：无含红包的会话");
    return;
  }

  // 取联系人名作为日志
  var contactName = getContactName(sessionNode);
  var sessionId   = buildSessionId(sessionNode);

  if (sessionId === lastSessionId) {
    debugLog("⏭️ 主页：会话已处理过（" + contactName + "）");
    return;
  }

  clog("info", "📋 主页发现红包会话：" + contactName + "，点击进入...");
  lastSessionId = sessionId;
  lastRPid = "";  // 进新会话，重置红包ID

  sessionNode.click();
  sleep(800);   // 等聊天界面加载

  // 进入聊天后立即扫红包
  scanChatForRP();
}

// ==================== 在主页找含红包摘要的会话行 ====================
function findRPSession() {
  try {
    for (var ki = 0; ki < KW.rpSummary.length; ki++) {
      var kw = KW.rpSummary[ki];
      // 找摘要 TextView（className=TextView，不可点击，text 含红包关键词）
      var summaryNodes = text(kw)
        .packageName(pkg)
        .className("android.widget.TextView")
        .clickable(false)
        .find();

      if (!summaryNodes || summaryNodes.size() === 0) continue;

      // 找到后向上找可点击的会话行节点
      for (var i = 0; i < summaryNodes.size(); i++) {
        var node = summaryNodes.get(i);
        // 排除聊天内的红包消息（聊天内节点深度更深）
        // 主页会话列表的摘要节点深度通常较浅（<= 10 层）
        if (node.depth() > 12) continue;

        var sessionNode = getClickableParent(node);
        if (sessionNode) {
          debugLog("📋 找到会话节点 kw=" + kw + " depth=" + node.depth());
          return sessionNode;
        }
      }
    }
  } catch(e) {
    debugLog("⚠️ findRPSession 异常: " + e);
  }
  return null;
}

// ==================== 获取会话联系人名称 ====================
function getContactName(sessionNode) {
  try {
    // 联系人名一般是会话行里第一个有文字的 TextView
    var children = sessionNode.find(className("android.widget.TextView").clickable(false));
    if (children && children.size() > 0) {
      // 遍历找最长且不含红包关键词的文字（联系人名）
      for (var i = 0; i < children.size(); i++) {
        var t = children.get(i).text();
        if (t && t.length > 0 && t.indexOf("红包") === -1 && t.length < 30) {
          return t;
        }
      }
    }
  } catch(e) {}
  return "未知联系人";
}

// ==================== 构建会话唯一 ID ====================
function buildSessionId(sessionNode) {
  try {
    var b = sessionNode.bounds();
    return b.top + "_" + b.left;
  } catch(e) { return ""; }
}

// ==================== 扫聊天内红包并抢 ====================
function scanChatForRP() {
  var rpNodes = findRedPackets();
  if (!rpNodes || rpNodes.length === 0) {
    debugLog("💬 聊天内：无红包节点");
    return;
  }

  debugLog("🔍 聊天内红包节点: " + rpNodes.length + " 个");

  for (var i = rpNodes.length - 1; i >= 0; i--) {
    var rpNode        = rpNodes[i];
    var clickableNode = getClickableParent(rpNode);
    if (!clickableNode) continue;

    var rpId = buildRPid(clickableNode);
    if (!rpId || rpId === lastRPid) {
      debugLog("⏭️ 跳过（ID重复）");
      continue;
    }

    // 节点属性判断是否已领取
    if (isAlreadyGrabbed(clickableNode)) {
      debugLog("⏭️ 已领取，跳过");
      lastRPid = rpId;
      continue;
    }

    lastRPid = rpId;
    clog("info", "🧧 发现未领红包，点击...");

    if (clickableNode.click()) {
      clog("info", "👆 已点击红包");
      sleep(CONFIG.TAP_DELAY);
      tapCenter();
      clog("info", "⚡ 已点中间，等待结果...");
      handleRPWindow();

      // 处理完后若不在聊天界面（已返回主页），停止继续扫
      if (isAtMainPage()) {
        debugLog("🏠 已回主页，停止聊天内扫描");
      }
      break;
    } else {
      clog("warn", "❌ 点击失败");
    }
  }
}

// ==================== 点击屏幕中间 ====================
function tapCenter() {
  var cx = device.width  / 2 | 0;
  var cy = (device.height * CONFIG.TAP_CENTER_Y) | 0;
  click(cx, cy);
  debugLog("⚡ tap(" + cx + ", " + cy + ")");
}

// ==================== 节点判断是否已领取 ====================
function isAlreadyGrabbed(node) {
  try {
    return containsText(node, KW.rpGrabbed) || containsText(node, KW.rpOpened);
  } catch(e) { return false; }
}

function containsText(node, target) {
  if (!node) return false;
  try {
    var t = node.text(), d = node.desc();
    if ((t && t.indexOf(target) !== -1) || (d && d.indexOf(target) !== -1)) return true;
    for (var i = 0; i < node.childCount(); i++) {
      if (containsText(node.child(i), target)) return true;
    }
  } catch(e) {}
  return false;
}

// ==================== 处理通知红包 ====================
function handleNotificationRP(notification) {
  try {
    clog("info", "🔔 点击通知...");
    notification.click();
    sleep(1200);
    var waited = 0;
    while (currentPackage() !== pkg && waited < 3000) { sleep(200); waited += 200; }
    if (currentPackage() === pkg) {
      sleep(CONFIG.TAP_DELAY);
      tapCenter();
      clog("info", "📱 进入微信，已点中间...");
      handleRPWindow();
    } else {
      clog("warn", "⚠️ 点通知后未进入微信");
    }
  } catch(e) {
    clog("error", "通知处理异常: " + (e.message || e));
  }
}

// ==================== 处理红包弹窗 ====================
function handleRPWindow() {
  var startTs  = new Date().getTime();
  var tapCount = 0;

  while (true) {
    if (new Date().getTime() - startTs > CONFIG.rpTimeout) {
      clog("warn", "⏰ 超时返回"); pressBack(); break;
    }
    if (currentPackage() !== pkg) { clog("warn", "⚠️ 离开微信"); break; }
    if (isAtMainPage()) { debugLog("🏠 回主界面"); break; }

    var screenText = dumpScreenText();

    // 抢到了
    if (screenText.indexOf(KW.rpDetail) !== -1) {
      totalGrabbed++;
      clog("ok", "🎉 抢到红包！累计: " + totalGrabbed + " 个");
      toast("抢到！共 " + totalGrabbed + " 个");
      sleep(400);
      var backBtn = desc(KW.descBack).findOne(800);
      if (backBtn) (backBtn.parent() || backBtn).click();
      else pressBack();
      sleep(CONFIG.backWaitTime);
      break;
    }

    // 已空
    var emptyKw = matchEmpty(screenText);
    if (emptyKw) {
      totalMissed++;
      clog("warn", "😢 已被领完「" + emptyKw + "」（错过: " + totalMissed + " 个）");
      closeRPDialog(); break;
    }

    // 已领取过
    if (screenText.indexOf(KW.rpGrabbed) !== -1) {
      clog("info", "ℹ️ 已领取过"); closeRPDialog(); break;
    }

    // 补点（最多3次）
    if (tapCount < 3) {
      sleep(300);
      tapCenter();
      tapCount++;
      debugLog("🔁 补点第" + tapCount + "次");
    } else {
      sleep(80);
    }
  }
}

// ==================== 查找聊天内红包节点 ====================
function findRedPackets() {
  try {
    var nodes = text(KW.rpText).packageName(pkg)
      .className("android.widget.TextView").clickable(false).find();
    if (!nodes || nodes.size() === 0) return null;
    var arr = [];
    for (var i = 0; i < nodes.size(); i++) arr.push(nodes.get(i));
    return arr;
  } catch(e) { return null; }
}

// ==================== 向上找可点击父节点 ====================
function getClickableParent(node) {
  try {
    var cur = node;
    for (var i = 0; i < 6; i++) {
      cur = cur.parent();
      if (!cur) return null;
      if (cur.clickable() && cur.longClickable()) return cur;
    }
  } catch(e) {}
  return null;
}

// ==================== 构建红包唯一 ID ====================
function buildRPid(node) {
  try {
    var b = node.bounds();
    return b.top + "_" + b.bottom + "_" + (node.column() > -1 ? node.column() : "x");
  } catch(e) { return ""; }
}

// ==================== 全量采集屏幕文本 ====================
function dumpScreenText() {
  var res = "";
  try {
    var root = getRootInActiveWindow ? getRootInActiveWindow() : null;
    if (root) res = collectText(root);
    else {
      var ns = className("android.widget.TextView").find();
      for (var i = 0; i < ns.size(); i++) { var t = ns.get(i).text(); if (t) res += t + " "; }
    }
  } catch(e) {}
  return res;
}

function collectText(node) {
  if (!node) return "";
  var res = "";
  try {
    var t = node.text(), d = node.desc();
    if (t) res += t + " ";
    if (d) res += d + " ";
    for (var i = 0; i < node.childCount(); i++) res += collectText(node.child(i));
  } catch(e) {}
  return res;
}

function matchEmpty(text) {
  for (var i = 0; i < KW.rpEmpty.length; i++) {
    if (text.indexOf(KW.rpEmpty[i]) !== -1) return KW.rpEmpty[i];
  }
  return null;
}

// ==================== 关闭弹窗 ====================
function closeRPDialog() {
  try {
    var btn = className("android.widget.ImageView").clickable(true).findOne(500);
    if (btn) { btn.click(); sleep(CONFIG.backWaitTime); return; }
  } catch(e) {}
  pressBack(); sleep(CONFIG.backWaitTime);
}

// ==================== 工具函数 ====================
function checkAccessibility() {
  try { className("android.widget.TextView").find(); return true; } catch(e) { return false; }
}
function pressBack() { try { back(); } catch(e) { KeyCode("KEYCODE_BACK"); } }

function printSummary() {
  var elapsed = Math.round((new Date().getTime() - startTime) / 1000);
  clog("info", "==============================");
  clog("info", "已停止，运行: " + elapsed + " 秒");
  clog("ok",   "抢到: " + totalGrabbed + " 个");
  clog("warn", "错过: " + totalMissed  + " 个");
}

// ==================== 日志 ====================
function clog(level, msg) {
  var t = new Date().toLocaleTimeString();
  var line = "[" + t + "] " + msg;
  var style = level === "ok"    ? "color:#07C160;font-weight:bold" :
              level === "warn"  ? "color:#FF9900;font-weight:bold" :
              level === "error" ? "color:#FF4444;font-weight:bold" :
                                  "color:#222222";
  console.log("%c" + line, style);
  log("[" + level.toUpperCase() + "] " + msg);
}

function debugLog(msg) {
  if (!CONFIG.debugLog) return;
  var t = new Date().toLocaleTimeString();
  console.log("%c[" + t + "] " + msg, "color:#AAAAAA;font-size:12px");
  log("[DBG] " + msg);
}
