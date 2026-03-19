'use strict';
// chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
// 		// skip urls like "chrome://" to avoid extension error
// 	if (tab.url?.startsWith("chrome://")) return undefined;	

// 	if (tab.active && changeInfo.status === "complete") {	
// 		console.info('inject')	
// 		chrome.scripting.executeScript({
// 			target: { tabId: tabId, allFrames: true },
// 			files: ['in-page.js']
// 		});
// 	}
// });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete") {
		chrome.scripting.executeScript({
			target: { tabId },
			files: ["in-page.js"]
		});
	}
});