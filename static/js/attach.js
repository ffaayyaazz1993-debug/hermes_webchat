var pendingImages = [];   // data URLs awaiting send
var pendingPdfs = [];     // extracted PDF text awaiting send
var imgPreviewRow = $("img-preview-row");
var imgFileInput = $("img-file-input");
var attachBtn = $("attach-btn");

function renderAttachments() {
  imgPreviewRow.innerHTML = "";
  if (!pendingImages.length && !pendingPdfs.length) { imgPreviewRow.hidden = true; return; }
  imgPreviewRow.hidden = false;
  pendingImages.forEach(function (url, i) {
    var t = document.createElement("div"); t.className = "img-thumb";
    var img = document.createElement("img"); img.src = url; img.alt = "Attached image " + (i + 1);
    var rm = document.createElement("button"); rm.className = "img-remove"; rm.innerHTML = "&times;"; rm.title = "Remove";
    rm.addEventListener("click", function () { pendingImages.splice(i, 1); renderAttachments(); });
    t.appendChild(img); t.appendChild(rm);
    imgPreviewRow.appendChild(t);
  });
  pendingPdfs.forEach(function (p, i) {
    var chip = document.createElement("div"); chip.className = "img-thumb"; chip.style.width = "auto"; chip.style.height = "auto"; chip.style.padding = "4px 8px"; chip.style.display = "flex"; chip.style.alignItems="center"; chip.style.gap="6px";
    var span = document.createElement("span"); span.textContent = "📄 " + p.name + " (attached)"; span.style.fontSize="12px"; span.style.color="var(--fg)";
    var rm = document.createElement("button"); rm.className = "img-remove"; rm.innerHTML = "&times;"; rm.title = "Remove";
    rm.addEventListener("click", function () { pendingPdfs.splice(i, 1); renderAttachments(); });
    chip.appendChild(span); chip.appendChild(rm);
    imgPreviewRow.appendChild(chip);
  });
}

attachBtn.addEventListener("click", function () { imgFileInput.click(); });
