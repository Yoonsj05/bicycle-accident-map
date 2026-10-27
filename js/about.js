
/*
  BIKE SAFE
  프로젝트 소개 페이지 탭 전환
*/

document.addEventListener("DOMContentLoaded", function() {

  const tabs = Array.from(
    document.querySelectorAll(".info-tab[data-tab]")
  );

  const panels = Array.from(
    document.querySelectorAll(".info-panel[role='tabpanel']")
  );

  function activateTab(name) {

    tabs.forEach(function(tab) {
      const active = tab.dataset.tab === name;

      tab.classList.toggle("active", active);
      tab.setAttribute(
        "aria-selected",
        String(active)
      );

      tab.tabIndex = active ? 0 : -1;
    });

    panels.forEach(function(panel) {
      panel.hidden = panel.id !== "panel-" + name;
    });
  }

  tabs.forEach(function(tab, index) {

    tab.addEventListener("click", function() {
      activateTab(tab.dataset.tab);
    });

    tab.addEventListener("keydown", function(event) {

      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      event.preventDefault();

      let next = index;

      if (event.key === "ArrowRight") {
        next = (index + 1) % tabs.length;
      }

      if (event.key === "ArrowLeft") {
        next = (index - 1 + tabs.length) % tabs.length;
      }

      if (event.key === "Home") {
        next = 0;
      }

      if (event.key === "End") {
        next = tabs.length - 1;
      }

      activateTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });

  activateTab("purpose");
});
