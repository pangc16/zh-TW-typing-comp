// 亮暗主題切換與介面設計預覽，index.html 與 dev.html 共用。
// 要放在 <head> 裡同步載入：在畫面畫出來之前就套用，才不會先閃一下另一種樣子。
(function () {
  var KEY = "typing:theme";
  var KEY_DESIGN = "typing:design";
  // 開發者專區「只在我的瀏覽器預覽」可以選的設計；classic 就是 style.css 本身
  var DESIGNS = ["timing", "classic"];
  var root = document.documentElement;
  var media = matchMedia("(prefers-color-scheme: dark)");

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var choice = read(KEY);
  root.dataset.theme = (choice ? choice === "dark" : media.matches) ? "dark" : "light";

  // 平常載入全站設計（由開發者專區決定，伺服器回傳對應的樣式）；
  // 這個瀏覽器有設預覽的話改載入預覽的那套，存在 localStorage，其他玩家看不到。
  // 用 document.write 才會在第一次繪製前載入完，不會先閃出別的樣式
  var preview = read(KEY_DESIGN);
  if (DESIGNS.indexOf(preview) !== -1) {
    root.dataset.design = preview;
    if (preview !== "classic") {
      document.write('<link rel="stylesheet" href="/designs/' + preview + '.css">');
    }
  } else {
    document.write('<link rel="stylesheet" href="/designs/site.css">');
  }

  // 還沒手動選過的話，系統切換亮暗時跟著變
  media.addEventListener("change", function (event) {
    if (!read(KEY)) root.dataset.theme = event.matches ? "dark" : "light";
  });

  // 用事件委派：這支程式跑的時候按鈕還沒出現在頁面上
  document.addEventListener("click", function (event) {
    if (!event.target.closest("#theme-btn")) return;
    var next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* 忽略 */ }
  });
})();
