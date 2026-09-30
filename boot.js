/* Кушетка для iPhone и iPad — запуск веб-приложения.
   1. Регистрирует service worker (ios/sw.js): он держит приложение без интернета и изображает
      помощника Windows-версии по адресам ./_h/… (данные, библиотека с Google Диска, перевод).
   2. Ждёт, пока service worker возьмёт страницу под контроль (при первом открытии — загрузка ~6 МБ),
      и только потом запускает страницу Кушетки (kushetka.js) с window.kushetkaMT = {…, ios: true}.
   3. Фоном докачивает библиотеку для работы без интернета, показывает обновления и подсказку
      «добавьте на экран „Домой“» в Safari. */
(function () {
  "use strict";
  var VERSION = "2026.09.30-2154";
  var scope = new URL("./", location.href).href;
  var H = scope + "_h/";
  var root = document.documentElement;
  var ua = navigator.userAgent || "";
  var isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var standalone = navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  root.classList.add("ios-app");
  if (isIOS) root.classList.add("is-ios");
  if (standalone) root.classList.add("standalone");
  var started = false;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function onReady(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); }

  /* ---- экран ожидания при первом открытии ---- */
  var loader = null;
  function showLoader(text) {
    onReady(function () {
      if (started) return;
      if (!loader) {
        loader = el("div", "ios-loader", '<div class="ios-loader-in"><svg viewBox="0 0 40 40" aria-hidden="true"><rect class="lg-a" x="4" y="15" width="32" height="7" rx="3.5"/><rect class="lg-b" x="28" y="11" width="9" height="5" rx="2.5"/><path class="lg-s" d="M10 22v11M30 22v11M7 33h7M27 33h7"/></svg><b>Кушетка</b><p></p></div>');
        loader.setAttribute("role", "status");
        document.body.appendChild(loader);
      }
      loader.querySelector("p").textContent = text;
    });
  }
  function hideLoader() { if (loader) { loader.remove(); loader = null; } }

  /* ---- полоса сообщений сверху (обновление, установка) ---- */
  function bar(id, html, actions) {
    onReady(function () {
      var old = document.getElementById(id); if (old) old.remove();
      var b = el("div", "ios-bar", '<p>' + html + '</p><div class="ios-bar-b"></div>');
      b.id = id; b.setAttribute("role", "status");
      (actions || []).forEach(function (a) {
        var btn = el("button", "btn sm" + (a.ghost ? " ghost" : ""), null);
        btn.type = "button"; btn.textContent = a.label;
        btn.addEventListener("click", function () { a.fn(b); });
        b.querySelector(".ios-bar-b").appendChild(btn);
      });
      document.body.insertBefore(b, document.body.firstChild);
    });
  }

  /* ---- запуск страницы Кушетки ---- */
  function start(helper) {
    if (started) return;
    started = true;
    if (helper) window.kushetkaMT = {base: H, token: "ios", ios: true, noweb: true, blob: true};
    showLoader("Открываю…");
    var s = document.createElement("script");
    s.src = "kushetka.js?v=" + encodeURIComponent(VERSION);
    s.onload = function () {
      hideLoader();
      if (helper) afterStart();
    };
    s.onerror = function () {
      started = false;
      showLoader("Нет связи, а приложение ещё не успело сохраниться на устройстве. Откройте Кушетку, когда появится интернет.");
    };
    document.body.appendChild(s);
  }

  function afterStart() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    prefetchLoop(20000);
    if (isIOS && !standalone) installHint();
  }

  /* фоном докачать тексты книг, индекс поиска, картинки и базу продуктов (без PDF и моделей) */
  var pfT = null;
  function prefetchLoop(delay) {
    clearTimeout(pfT);
    pfT = setTimeout(function () {
      if (!navigator.onLine || document.hidden) { prefetchLoop(30000); return; }
      fetch(H + "lib/prefetch?t=ios&budget=40000", {method: "POST"}).then(function (r) { return r.json(); }).then(function (j) {
        if (j.left > 0) prefetchLoop(2000); else if (j.left < 0) prefetchLoop(120000);
      }).catch(function () { prefetchLoop(60000); });
    }, delay);
  }

  function installHint() {
    try { if (sessionStorage.getItem("kushetka-install-hint") === "no") return; } catch (e) {}
    bar("ios-install", '<b>Установите Кушетку на экран «Домой».</b> В Safari нажмите «Поделиться» <span class="ios-share" aria-hidden="true"></span> → «На экран „Домой“». Так она откроется без адресной строки и будет работать без интернета. Данные в Safari и в установленной Кушетке хранятся отдельно — работайте в установленной.',
      [{label: "Понятно", ghost: true, fn: function (b) { b.remove(); try { sessionStorage.setItem("kushetka-install-hint", "no"); } catch (e) {} }}]);
  }

  /* ---- service worker ---- */
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    start(false);
    bar("ios-nosw", "Этот браузер не даёт приложению работать без интернета: библиотека и перевод недоступны, данные хранятся только в браузере. Откройте Кушетку в Safari.", [{label: "Закрыть", ghost: true, fn: function (b) { b.remove(); }}]);
    return;
  }
  var sw = navigator.serviceWorker;
  if (!sw.controller) showLoader("Готовлю Кушетку к работе без интернета…");
  sw.register("sw.js", {scope: "./"}).then(function (reg) {
    watchUpdates(reg);
    if (sw.controller) { start(true); return; }
    var t = setTimeout(function () {
      if (started) return;
      start(!!sw.controller);
      if (!sw.controller) bar("ios-nosw", "Кушетка ещё не сохранилась на устройстве: библиотека и перевод заработают после перезапуска.", [{label: "Перезапустить", fn: function () { location.reload(); }}]);
    }, 60000);
    sw.addEventListener("controllerchange", function once() {
      sw.removeEventListener("controllerchange", once);
      clearTimeout(t);
      start(true);
    });
  }).catch(function () {
    start(false);
    bar("ios-nosw", "Не получилось включить работу без интернета: библиотека и перевод недоступны.", [{label: "Закрыть", ghost: true, fn: function (b) { b.remove(); }}]);
  });

  function watchUpdates(reg) {
    function offer(w) {
      if (!w || !sw.controller) return;
      bar("ios-update", "<b>Кушетка обновилась.</b> Новая версия включится при следующем запуске.", [
        {label: "Обновить сейчас", fn: function () { w.postMessage({t: "skip"}); }},
        {label: "Позже", ghost: true, fn: function (b) { b.remove(); }}]);
    }
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener("updatefound", function () {
      var w = reg.installing; if (!w) return;
      w.addEventListener("statechange", function () { if (w.state === "installed") offer(w); });
    });
    var reloading = false;
    sw.addEventListener("controllerchange", function () {
      if (!started || reloading || !window.__kushetkaBeforeClose) return;
      reloading = true;
      Promise.resolve(window.__kushetkaBeforeClose()).catch(function () {}).then(function () { location.reload(); });
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) reg.update().catch(function () {}); });
  }
})();
