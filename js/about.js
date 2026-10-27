
/*
  BIKE SAFE - 프로젝트 소개
  탭 전환 + 서울 전체 상대적 위험도 안내
*/

document.addEventListener("DOMContentLoaded", async function() {

  const tabs = Array.from(
    document.querySelectorAll(".info-tab[data-tab]")
  );

  const panels = Array.from(
    document.querySelectorAll(
      ".info-panel[role='tabpanel']"
    )
  );

  function activateTab(name) {
    tabs.forEach(tab => {
      const active = tab.dataset.tab === name;

      tab.classList.toggle("active", active);
      tab.setAttribute(
        "aria-selected",
        String(active)
      );
      tab.tabIndex = active ? 0 : -1;
    });

    panels.forEach(panel => {
      panel.hidden =
        panel.id !== "panel-" + name;
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
    });

    tab.addEventListener("keydown", event => {
      if (![
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End"
      ].includes(event.key)) return;

      event.preventDefault();

      let next = index;

      if (event.key === "ArrowRight") {
        next = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        next =
          (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = tabs.length - 1;
      }

      activateTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });

  activateTab("purpose");

  // 위험도 페이지의 기존 고정 점수 안내를
  // 서울 전체 백분위 기준으로 변경
  const riskPanel =
    document.getElementById("panel-risk");

  if (!riskPanel) return;

  let tools;

  try {
    tools = await import("./risk.js");
  } catch (error) {
    console.error("위험도 모듈 연결 실패", error);
    return;
  }

  const reference = tools.readRiskReference();
  const ranges = tools.getRiskRanges(reference);

  // 기존 점수 산정 공식은 그대로 유지
  const introduction = riskPanel.querySelector(
    ".panel-intro"
  );

  if (introduction) {
    const description =
      introduction.querySelector("p");

    if (description) {
      description.textContent =
        "사고·인명피해 점수 + " +
        "서울 전체 백분위수 등급";
    }
  }

  const bands = riskPanel.querySelectorAll(
    ".risk-band"
  );

  const bandValues = [
    ["주의", ranges.low],
    ["높음", ranges.medium],
    ["매우 높음", ranges.high]
  ];

  bands.forEach((band, index) => {
    if (!bandValues[index]) return;

    const strong = band.querySelector("strong");
    const span = band.querySelector("span");

    if (strong) {
      strong.textContent = bandValues[index][0];
    }

    if (span) {
      span.textContent = bandValues[index][1];
    }
  });

  // 기존 공식 밑에 분석 방식 설명 표시
  const existingNote =
    riskPanel.querySelector(".small-note");

  if (existingNote) {
    existingNote.textContent =
      "위험도 점수 공식은 유지하고, " +
      "서울 전체 사고지역의 50백분위와 " +
      "80백분위를 경계로 등급을 구분해. " +
      "자치구를 바꿔도 기준은 동일해. " +
      "공식 위험등급은 아니야.";
  }

  const description = document.createElement("p");
  description.className = "small-note";

  description.textContent =
    tools.getRiskDescription(reference);

  riskPanel.appendChild(description);

  if (!reference) {
    const notice = document.createElement("p");
    notice.className = "small-note";
    notice.textContent =
      "서울 전체 데이터를 완전히 조회한 뒤 " +
      "지도 또는 사고 분석 페이지에서 " +
      "실제 기준점수가 계산돼.";

    riskPanel.appendChild(notice);
  }
});
