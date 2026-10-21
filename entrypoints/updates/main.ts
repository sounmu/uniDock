import "./style.css";

document.getElementById("version")!.textContent =
  chrome.runtime.getManifest().version;
document
  .getElementById("close")!
  .addEventListener("click", () => window.close());
