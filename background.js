var queueTabs = []
var num = 0;
var to;
var ti;
var wi;
var switching = 0;

chrome.commands.onCommand.addListener(function(command) {
	if (command == "switch"){
		clearTimeout(to);
		switching = 1;
		activeTabId();
		num = ((num - 1 + queueTabs.length) % queueTabs.length);
		if (ti == queueTabs[num])
			num = ((num - 1 + queueTabs.length) % queueTabs.length);
		chrome.tabs.update(queueTabs[num], {active: true});
		to = setTimeout(changeActiveTab, 1000);
	}
	if (command == "showQueue"){
		alert(queueTabs);
	}
})

chrome.tabs.onRemoved.addListener(function(tabId) {
	var index = queueTabs.indexOf(tabId);
	if (index != -1){
		queueTabs.splice(index, 1);
	}
})

function activeTabId(){
	chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
		ti = tabs[0].id;
	});
}

function changeActiveTab(){
	switching = 0;
	num = queueTabs.length;
	var idActiveTab = ti;
	var index = queueTabs.indexOf(idActiveTab);
	if (index != -1){
		queueTabs.splice(index, 1);
	}
	queueTabs.push(idActiveTab);
}

chrome.tabs.onActivated.addListener(function (ai){
	ti = ai.tabId;
	if (switching != 1){
		changeActiveTab();
}
})