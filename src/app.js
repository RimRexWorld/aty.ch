// Lightbox. No dependencies, ~2 kB, deferred — the page is fully readable and
// every photo is already visible before this runs. It only adds "look closer",
// which is the one thing a buyer actually wants from a listing gallery.
(function () {
  "use strict";

  var figures = Array.prototype.slice.call(document.querySelectorAll(".ph[data-index]"));
  if (!figures.length) return;

  var box = document.getElementById("lightbox");
  var stage = box.querySelector(".lb-stage");
  var count = box.querySelector(".lb-count");
  var current = -1;
  var lastFocus = null;

  /** Pull the srcset/alt the build already emitted — no second source of truth. */
  function describe(fig) {
    var sources = fig.querySelectorAll("source");
    var img = fig.querySelector("img");
    var set = {};
    Array.prototype.forEach.call(sources, function (s) { set[s.type] = s.srcset; });
    return {
      avif: set["image/avif"],
      webp: set["image/webp"],
      jpg: img.getAttribute("srcset"),
      src: img.getAttribute("src"),
      alt: img.getAttribute("alt"),
      // What the browser actually decoded for the thumbnail. Painting it as the
      // background means the full-size file fades in over a sharp image rather
      // than over an empty frame.
      poster: img.currentSrc || img.src,
      ratio: img.getAttribute("width") + " / " + img.getAttribute("height")
    };
  }

  function build(d) {
    var pic = document.createElement("picture");
    [["image/avif", d.avif], ["image/webp", d.webp]].forEach(function (pair) {
      if (!pair[1]) return;
      var s = document.createElement("source");
      s.type = pair[0];
      s.srcset = pair[1];
      s.sizes = "100vw";
      pic.appendChild(s);
    });
    var img = document.createElement("img");
    img.srcset = d.jpg;
    img.sizes = "100vw";
    img.src = d.src;
    img.alt = d.alt;
    img.decoding = "async";
    img.style.aspectRatio = d.ratio;
    img.style.backgroundImage = "url(" + JSON.stringify(d.poster) + ")";
    img.addEventListener("load", function () { img.style.backgroundImage = ""; }, { once: true });
    pic.appendChild(img);
    return pic;
  }

  function show(i) {
    current = (i + figures.length) % figures.length;
    var d = describe(figures[current]);
    stage.textContent = "";
    stage.appendChild(build(d));
    count.textContent = current + 1 + " / " + figures.length;

    // Warm the neighbours so arrowing through does not stall on mobile data.
    [current + 1, current - 1].forEach(function (n) {
      var fig = figures[(n + figures.length) % figures.length];
      var warm = new Image();
      var nd = describe(fig);
      warm.srcset = nd.webp || nd.jpg;
      warm.sizes = "100vw";
      warm.src = nd.src;
    });
  }

  function open(i) {
    lastFocus = document.activeElement;
    box.hidden = false;
    document.body.classList.add("lb-open");
    show(i);
    box.querySelector(".lb-close").focus();
  }

  function close() {
    box.hidden = true;
    stage.textContent = "";
    document.body.classList.remove("lb-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  figures.forEach(function (fig, i) {
    fig.addEventListener("click", function () { open(i); });
  });

  box.querySelector(".lb-close").addEventListener("click", close);
  box.querySelector(".lb-prev").addEventListener("click", function () { show(current - 1); });
  box.querySelector(".lb-next").addEventListener("click", function () { show(current + 1); });

  box.addEventListener("click", function (e) {
    // Backdrop only — clicking the photo itself should not dismiss it.
    if (e.target === box || e.target === stage) close();
  });

  document.addEventListener("keydown", function (e) {
    if (box.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(current + 1);
    else if (e.key === "ArrowLeft") show(current - 1);
    else if (e.key === "Tab") {
      // Minimal trap: three buttons, keep focus among them.
      var btns = box.querySelectorAll("button");
      var idx = Array.prototype.indexOf.call(btns, document.activeElement);
      var next = e.shiftKey ? idx - 1 : idx + 1;
      e.preventDefault();
      btns[(next + btns.length) % btns.length].focus();
    }
  });

  var startX = null, startY = null;
  box.addEventListener("touchstart", function (e) {
    startX = e.changedTouches[0].clientX;
    startY = e.changedTouches[0].clientY;
  }, { passive: true });

  box.addEventListener("touchend", function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    var dy = e.changedTouches[0].clientY - startY;
    // Horizontal intent only, so a vertical flick to dismiss never counts.
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
    startX = startY = null;
  }, { passive: true });
})();
