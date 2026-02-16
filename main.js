/**
 * 微信自动抢红包脚本 v8
 * AutoJS 6 专用
 *
 * v8 修复：
 *  1. 通知监听：改用 events.onNotification，兼容 AutoJS 6
 *  2. 主页会话扫描：改用 bounds 范围匹配 + 放宽 depth 限制，
 *     同时用"含红包关键词的摘要节点"向上找会话行，更稳健
 *  3. lastSessionId 只在当次进入标记，处理完毕后立即清空，
 *     同一会话有新红包时依然能重复触发
 *  4. 彻底去掉所有"定时/主动回主页"逻辑，脚本不强制跳转
 *  5. isAlreadyGrabbed 改为在聊天气泡节点子树内查找，而非整屏
 *  6. findRedPackets 增加多路 selector，覆盖不同微信版本节点结构
 */

auto.waitFor();          // 等待无障碍服务就绪

// ==================== Console ====================
console.show();
console.setSize(device.width * 0.92, 420);
console.setPosition(device.width * 0.04, 50);
console.setTitle("🧧 微信抢红包 v8");
console.setTitleTextColor("#FFFFFF");
console.setTitleBackgroundColor("#07C160");

// ==================== 配置 ====================
var pkg = "com.tencent.mm";

var CONFIG = {
  launchWait:    3000,
  scanInterval:  180,   // 主循环间隔(ms)
  rpTimeout:     6000,  // 等待红包结果超时(ms)
  backWaitTime:  500,
  TAP_DELAY:     120,   // 点红包后延迟点中间(ms)
  TAP_CENTER_Y:  0.62,  // 红包"开"按钮 Y 轴比例
  sessionDepthMax: 14,  // 主页摘要节点深度上限（过深说明在聊天内）
  debugLog:      true,
};

// ==================== 关键词 ====================
var KW = {
  rpText:     "微信红包",
  rpSummary:  ["[微信红包]", "微信红包"],
  rpGrabbed:  "已领取",
  rpOpened:   "已被领完",
  rpDetail:   "红包详情",
  rpEmpty:    ["手慢了", "已被领完", "已领完", "来晚了", "查看领取详情"],
  descBack:   "返回",
  descSearch: "搜索",
};

// ==================== 全局状态 ====================
var lastRPid      = "";
var lastSessionId = "";
var totalGrabbed  = 0;
var totalMissed   = 0;
var startTime     = new Date().getTime();

// ==================== 通知监听（AutoJS 6 正确 API）====================
/*
 * AutoJS 6 中正确的通知监听方式：
 *   events.onNotification(function(notification){...})
 * 而非 setDefaultNotificationHandler（该 API 在 AutoJS 4/Pro 使用）
 * 需要在"通知使用权"中授权 AutoJS
 */
var notificationQueue = [];

function setupNotificationListener() {
  try {
    events.onNotification(function(notification) {
      try {
        var pkgName = notification.getPackageName
          ? notification.getPackageName()
          : (notification.packageName || "");
        if (pkgName !== pkg) return;
        var title   = notification.getTitle ? notification.getTitle() : (notification.title || "");
        var content = notification.getText  ? notification.getText()  : (notification.content || "");
        var full    = (title + " " + content) + "";
        if (full.indexOf("红包") !== -1) {
          clog("info", "🔔 通知含红包: " + full.substring(0, 40));
          notificationQueue.push(notification);
        }
      } catch(e) { debugLog("通知回调异常: " + e); }
    });
    clog("ok", "通知监听已启动（events.onNotification）✓");
  } catch(e) {
    clog("warn", "通知监听失败（需授权通知使用权）: " + e);
  }
}

// ==================== 主入口 ====================
main();

function main() {
  clog("info", "=== 微信抢红包 v8 启动 ===");
  clog("info", "时间: " + new Date().toLocaleString());
  clog("info", "设备: " + device.brand + " " + device.model);
  clog("info", "屏幕: " + device.width + "x" + device.height);
  clog("info", "------------------------------");

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
  while (true) {
    try {

      // 1. 优先处理通知队列
      if (notificationQueue.length > 0) {
        handleNotificationRP(notificationQueue.shift());
        sleep(CONFIG.scanInterval);
        continue;
      }

      if (currentPackage() !== pkg) {
        debugLog("⏳ 等待微信前台...");
        sleep(600);
        continue;
      }

      // 2. 分界面处理
      if (isAtMainPage()) {
        scanMainPageForRP();
      } else {
        scanChatForRP();
      }

    } catch(e) {
      clog("error", "循环异常: " + (e.message || e));
    }

    sleep(CONFIG.scanInterval);
  }
}

// ==================== 判断是否在微信主页 ====================
function isAtMainPage() {
  // 主页有搜索图标，没有"返回"图标
  return desc(KW.descSearch).exists() && !desc(KW.descBack).exists();
}

// ==================== 扫主页会话列表 ====================
/*
 * 修复要点：
 *   - 放宽 depth 上限至 CONFIG.sessionDepthMax（默认14）
 *   - 不再依赖 depth 精确判断，改为：找到摘要节点后，
 *     检查其 parent 链上是否有同类兄弟节点（联系人名、时间），
 *     从而确认是会话行而非聊天气泡
 *   - lastSessionId 处理完毕后立即清空，允许再次进入同一会话
 */
function scanMainPageForRP() {
  var sessionNode = findRPSession();
  if (!sessionNode) {
    debugLog("📋 主页：无含红包的会话");
    return;
  }

  var contactName = getContactName(sessionNode);
  var sessionId   = buildSessionId(sessionNode);

  // 同一个会话行：仅在本次点击周期内去重（点完即清空）
  if (sessionId !== "" && sessionId === lastSessionId) {
    debugLog("⏭️ 主页：同一会话去重（" + contactName + "）");
    return;
  }

  clog("info", "📋 主页发现红包会话：" + contactName + "，点击进入...");
  lastSessionId = sessionId;
  lastRPid = "";   // 进新会话，重置红包ID

  sessionNode.click();
  sleep(900);    // 等聊天界面加载

  // 进入聊天后立即扫红包
  scanChatForRP();

  // ✅ 处理完毕立即清空，下次还能进同一会话
  lastSessionId = "";
}

// ==================== 找含红包摘要的会话行节点 ====================
function findRPSession() {
  try {
    for (var ki = 0; ki < KW.rpSummary.length; ki++) {
      var kw = KW.rpSummary[ki];

      // 主页摘要可能是 text() 或 desc()
      var byText = text(kw).packageName(pkg).find();
      var byDesc = desc(kw).packageName(pkg).find();
      var candidates = mergeNodeLists(byText, byDesc);

      for (var i = 0; i < candidates.length; i++) {
        var node = candidates[i];

        // 深度过深说明在聊天气泡里，跳过
        if (node.depth() > CONFIG.sessionDepthMax) {
          debugLog("⏭️ 节点深度=" + node.depth() + " 超限，跳过（聊天内节点）");
          continue;
        }

        // 向上找可点击的会话行
        var sessionNode = getClickableParent(node, 8);
        if (!sessionNode) continue;

        // 验证：会话行内应同时含有联系人名和时间（TextView>=2个）
        if (!isLikelySessionRow(sessionNode)) {
          debugLog("⏭️ 候选节点不像会话行，跳过");
          continue;
        }

        debugLog("📋 命中会话摘要 kw=" + kw + " depth=" + node.depth());
        return sessionNode;
      }
    }
  } catch(e) {
    debugLog("⚠️ findRPSession 异常: " + e);
  }
  return null;
}

// 合并两个 find() 结果为 JS 数组，去重
function mergeNodeLists(a, b) {
  var arr = [];
  var seen = {};
  function addList(list) {
    if (!list) return;
    for (var i = 0; i < list.size(); i++) {
      var n = list.get(i);
      try {
        var key = n.bounds().toShortString();
        if (!seen[key]) { seen[key] = true; arr.push(n); }
      } catch(e) { arr.push(n); }
    }
  }
  addList(a); addList(b);
  return arr;
}

// 判断节点是否像主页会话行（含有联系人名 + 时间两个短 TextView）
function isLikelySessionRow(node) {
  try {
    var tvs = node.find(className("android.widget.TextView"));
    if (!tvs || tvs.size() < 2) return false;
    var nonEmptyCount = 0;
    for (var i = 0; i < tvs.size(); i++) {
      var t = tvs.get(i).text();
      if (t && t.trim().length > 0) nonEmptyCount++;
    }
    return nonEmptyCount >= 2;
  } catch(e) { return true; } // 出错时宽容处理
}

// ==================== 获取联系人名 ====================
function getContactName(sessionNode) {
  try {
    var children = sessionNode.find(className("android.widget.TextView"));
    for (var i = 0; i < children.size(); i++) {
      var t = children.get(i).text();
      if (t && t.length > 0 && t.indexOf("红包") === -1 && t.length < 30) {
        return t;
      }
    }
  } catch(e) {}
  return "未知联系人";
}

// ==================== 构建会话唯一 ID ====================
function buildSessionId(node) {
  try {
    var b = node.bounds();
    return b.top + "_" + b.left + "_" + b.right;
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

  // 从最新（底部）开始遍历
  for (var i = rpNodes.length - 1; i >= 0; i--) {
    var rpNode        = rpNodes[i];
    var clickableNode = getClickableParent(rpNode, 6);
    if (!clickableNode) continue;

    var rpId = buildRPid(clickableNode);
    if (rpId && rpId === lastRPid) {
      debugLog("⏭️ 跳过（ID重复）");
      continue;
    }

    // 判断该红包气泡是否已领取（在子树内查，而非全屏）
    if (isAlreadyGrabbed(clickableNode)) {
      debugLog("⏭️ 已领取，跳过");
      if (rpId) lastRPid = rpId;
      continue;
    }

    if (rpId) lastRPid = rpId;
    clog("info", "🧧 发现未领红包，点击...");

    if (clickableNode.click()) {
      clog("info", "👆 已点击红包");
      sleep(CONFIG.TAP_DELAY);
      tapCenter();
      clog("info", "⚡ 已点中间，等待结果...");
      handleRPWindow();
      break;  // 一次循环只处理一个红包，处理完重新扫
    } else {
      clog("warn", "❌ 点击节点失败，尝试坐标点击");
      try {
        var b = clickableNode.bounds();
        click(b.centerX(), b.centerY());
        sleep(CONFIG.TAP_DELAY);
        tapCenter();
        handleRPWindow();
      } catch(e) { clog("warn", "坐标点击也失败: " + e); }
      break;
    }
  }
}

// ==================== 点屏幕中间 ====================
function tapCenter() {
  var cx = device.width  / 2 | 0;
  var cy = (device.height * CONFIG.TAP_CENTER_Y) | 0;
  click(cx, cy);
  debugLog("⚡ tap(" + cx + ", " + cy + ")");
}

// ==================== 判断红包气泡是否已领取（子树内）====================
function isAlreadyGrabbed(node) {
  return containsText(node, KW.rpGrabbed) || containsText(node, KW.rpOpened);
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
    clog("info", "🔔 点击通知进入微信...");
    notification.click();
    sleep(1500);
    var waited = 0;
    while (currentPackage() !== pkg && waited < 4000) { sleep(200); waited += 200; }
    if (currentPackage() === pkg) {
      sleep(400);
      // 如果落在聊天界面就直接扫；如果在主页也会被主循环捕获
      if (!isAtMainPage()) {
        sleep(CONFIG.TAP_DELAY);
        tapCenter();
        clog("info", "📱 进入聊天，已点中间...");
        handleRPWindow();
      } else {
        clog("info", "📱 在主页，交给主循环处理");
        scanMainPageForRP();
      }
    } else {
      clog("warn", "⚠️ 点通知后未进入微信（当前包: " + currentPackage() + "）");
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
    var elapsed = new Date().getTime() - startTs;
    if (elapsed > CONFIG.rpTimeout) {
      clog("warn", "⏰ 超时，停止等待结果");
      break;
    }
    if (currentPackage() !== pkg) { clog("warn", "⚠️ 离开微信"); break; }
    if (isAtMainPage())           { debugLog("🏠 回主界面"); break; }

    var screenText = dumpScreenText();

    // 抢到了
    if (screenText.indexOf(KW.rpDetail) !== -1) {
      totalGrabbed++;
      clog("ok", "🎉 抢到红包！累计: " + totalGrabbed + " 个");
      toast("抢到！共 " + totalGrabbed + " 个");
      sleep(400);
      var backBtn = desc(KW.descBack).findOne(800);
      if (backBtn) {
        var par = backBtn.parent();
        (par || backBtn).click();
      } else {
        pressBack();
      }
      sleep(CONFIG.backWaitTime);
      break;
    }

    // 已空
    var emptyKw = matchEmpty(screenText);
    if (emptyKw) {
      totalMissed++;
      clog("warn", "😢 「" + emptyKw + "」，手慢了（错过: " + totalMissed + " 个）");
      closeRPDialog();
      break;
    }

    // 已领取过
    if (screenText.indexOf(KW.rpGrabbed) !== -1) {
      clog("info", "ℹ️ 已领取过");
      closeRPDialog();
      break;
    }

    // 还在弹窗动画中，补点（最多3次）
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
/*
 * 修复：多路 selector 覆盖不同微信版本
 *   1. text("微信红包") + TextView + clickable(false)  ← 最常见
 *   2. text("微信红包") + 无 className 限制             ← 备选
 *   3. desc 包含"微信红包"                              ← 部分版本用 desc
 */
function findRedPackets() {
  try {
    var results = [];
    var seen = {};

    function addNodes(list) {
      if (!list || list.size() === 0) return;
      for (var i = 0; i < list.size(); i++) {
        var n = list.get(i);
        try {
          var key = n.bounds().toShortString();
          if (!seen[key]) { seen[key] = true; results.push(n); }
        } catch(e) { results.push(n); }
      }
    }

    // 路径1：text 精确匹配 TextView 不可点击（最严格，最准确）
    addNodes(text(KW.rpText).packageName(pkg).className("android.widget.TextView").clickable(false).find());
    // 路径2：text 精确匹配，放开 className
    addNodes(text(KW.rpText).packageName(pkg).clickable(false).find());
    // 路径3：desc 匹配
    addNodes(desc(KW.rpText).packageName(pkg).find());
    // 路径4：textContains 模糊匹配（兜底）
    addNodes(textContains(KW.rpText).packageName(pkg).clickable(false).find());

    return results.length > 0 ? results : null;
  } catch(e) {
    debugLog("findRedPackets 异常: " + e);
    return null;
  }
}

// ==================== 向上找可点击父节点 ====================
function getClickableParent(node, maxDepth) {
  maxDepth = maxDepth || 6;
  try {
    var cur = node;
    for (var i = 0; i < maxDepth; i++) {
      cur = cur.parent();
      if (!cur) return null;
      if (cur.clickable()) return cur;
    }
  } catch(e) {}
  return null;
}

// ==================== 构建红包唯一 ID ====================
function buildRPid(node) {
  try {
    var b = node.bounds();
    return b.top + "_" + b.bottom + "_" + b.left;
  } catch(e) { return ""; }
}

// ==================== 全量采集屏幕文本 ====================
function dumpScreenText() {
  var res = "";
  try {
    var root = null;
    try { root = getRootInActiveWindow(); } catch(e) {}
    if (root) {
      res = collectText(root);
    } else {
      var ns = className("android.widget.TextView").find();
      for (var i = 0; i < ns.size(); i++) {
        var t = ns.get(i).text();
        if (t) res += t + " ";
      }
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
    for (var i = 0; i < node.childCount(); i++) {
      res += collectText(node.child(i));
    }
  } catch(e) {}
  return res;
}

function matchEmpty(screenText) {
  for (var i = 0; i < KW.rpEmpty.length; i++) {
    if (screenText.indexOf(KW.rpEmpty[i]) !== -1) return KW.rpEmpty[i];
  }
  return null;
}

// ==================== 关闭弹窗 ====================
function closeRPDialog() {
  try {
    // 尝试点关闭按钮（ImageView 可点击）
    var btn = className("android.widget.ImageView").clickable(true).findOne(600);
    if (btn) { btn.click(); sleep(CONFIG.backWaitTime); return; }
  } catch(e) {}
  pressBack();
  sleep(CONFIG.backWaitTime);
}

// ==================== 工具函数 ====================
function pressBack() {
  try { back(); } catch(e) { KeyCode("KEYCODE_BACK"); }
}

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
