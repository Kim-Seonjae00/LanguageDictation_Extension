import { Msg, type ExtNoPayloadMessage, type NoPayloadMsgType } from "../shared/protocol";

console.log("Popup script loaded");

const $start = document.querySelector<HTMLButtonElement>("#start")!;
const $stop = document.querySelector<HTMLButtonElement>("#stop")!;
const $result = document.querySelector<HTMLPreElement>("#result")!;

function sendToActiveTab<T extends NoPayloadMsgType>(type: T) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs?.[0]?.id;
    if (!tabId) return;

    const msg: ExtNoPayloadMessage<T> = { type };
    chrome.tabs.sendMessage(tabId, msg);
  });
}

$start.addEventListener("click", () => {
  $result.textContent = "Started...";
  sendToActiveTab(Msg.START);
});

$stop.addEventListener("click", () => {
  $result.textContent = "Stopped.";
  sendToActiveTab(Msg.STOP);
});