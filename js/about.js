
/*
  BIKE SAFE - 프로젝트 소개 페이지

  기존 기능:
  - 프로젝트 소개 5개 탭
  - 탭 클릭 및 키보드 이동
  - 위험도 계산 공식 안내
  - 서울 전체 백분위 위험도 기준 표시

  이번 최적화:
  - 기존 HTML/CSS 구조 유지
  - 위험도 기준 미저장 상태 안전하게 처리
  - 중복 설명 요소 생성 방지
  - 자료 없음과 미조회 상태 설명 개선
*/

document.addEventListener(
  "DOMContentLoaded",
  async function () {

    // ====================================
    // 1. 기존 소개 탭 가져오기
    // ====================================

    const tabs = Array.from(
      document.querySelectorAll(
        ".info-tab[data-tab]"
      )
    );

    const panels = Array.from(
      document.querySelectorAll(
        ".info-panel[role='tabpanel']"
      )
    );

    // ====================================
    // 2. 소개 탭 전환
    // ====================================

    function activateTab(name) {
      const target = panels.find(
        panel => panel.id === "panel-" + name
      );

      if (!target) {
        return;
      }

      tabs.forEach(tab => {
        const active =
          tab.dataset.tab === name;

        tab.classList.toggle(
          "active",
          active
        );

        tab.setAttribute(
          "aria-selected",
          String(active)
        );

        tab.tabIndex =
          active ? 0 : -1;
      });

      panels.forEach(panel => {
        panel.hidden =
          panel !== target;
      });
    }

    // ====================================
    // 3. 마우스 및 키보드 조작
    // ====================================

    tabs.forEach((tab, index) => {

      tab.addEventListener(
        "click",
        () => {
          activateTab(tab.dataset.tab);
        }
      );

      tab.addEventListener(
        "keydown",
        event => {

          const keys = [
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End"
          ];

          if (!keys.includes(event.key)) {
            return;
          }

          event.preventDefault();

          let next = index;

          if (event.key === "ArrowRight") {
            next =
              (index + 1) % tabs.length;

          } else if (
            event.key === "ArrowLeft"
          ) {
            next =
              (index - 1 + tabs.length) %
              tabs.length;

          } else if (
            event.key === "Home"
          ) {
            next = 0;

          } else if (
            event.key === "End"
          ) {
            next = tabs.length - 1;
          }

          const nextTab = tabs[next];

          activateTab(
            nextTab.dataset.tab
          );

          nextTab.focus();
        }
      );
    });

    // 기존 첫 화면 유지
    activateTab("purpose");

    // ====================================
    // 4. 위험도 기준 패널
    // ====================================

    const riskPanel =
      document.getElementById(
        "panel-risk"
      );

    if (!riskPanel) {
      return;
    }

    // ====================================
    // 5. 공통 위험도 모듈 불러오기
    // ====================================

    let tools;

    try {
      tools = await import("./risk.js");

    } catch (error) {
      console.error(
        "BIKE SAFE 위험도 모듈 연결 실패:",
        error
      );

      // 다른 소개 탭은 그대로 사용 가능
      return;
    }

    // ====================================
    // 6. 서울 전체 위험도 기준 읽기
    // ====================================

    let reference = null;

    try {
      reference =
        tools.readRiskReference();

    } catch (error) {
      console.warn(
        "저장된 위험도 기준을 읽지 못했습니다.",
        error
      );
    }

    const ranges =
      tools.getRiskRanges(reference);

    // ====================================
    // 7. 위험도 소개 문구
    // ====================================

    const introduction =
      riskPanel.querySelector(
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

    // ====================================
    // 8. 위험도 색상 카드
    // ====================================

    const bands =
      riskPanel.querySelectorAll(
        ".risk-band"
      );

    const bandValues = [
      ["주의", ranges.low],
      ["높음", ranges.medium],
      ["매우 높음", ranges.high]
    ];

    bands.forEach((band, index) => {
      const value = bandValues[index];

      if (!value) {
        return;
      }

      const strong =
        band.querySelector("strong");

      const span =
        band.querySelector("span");

      if (strong) {
        strong.textContent = value[0];
      }

      if (span) {
        span.textContent = value[1];
      }
    });

    // ====================================
    // 9. 위험도 기준 설명
    // ====================================

    const existingNote =
      riskPanel.querySelector(
        ".small-note"
      );

    if (existingNote) {
      existingNote.textContent =
        "위험도 점수 공식은 유지하고, " +
        "서울 전체 사고지역 점수의 " +
        "50백분위와 80백분위를 경계로 " +
        "등급을 구분해. " +
        "자치구를 바꿔도 서울 전체를 " +
        "기준으로 비교해. " +
        "이 등급은 공식 위험등급이 아닌 " +
        "BIKE SAFE 자체 분석 결과야.";
    }

    // ====================================
    // 10. 실제 점수 기준 설명
    // ====================================

    // 화면을 중복 갱신하더라도
    // 같은 설명이 여러 번 생기지 않도록 함
    let description =
      riskPanel.querySelector(
        ".bike-risk-reference-description"
      );

    if (!description) {
      description =
        document.createElement("p");

      description.className =
        "small-note " +
        "bike-risk-reference-description";

      riskPanel.appendChild(
        description
      );
    }

    description.textContent =
      tools.getRiskDescription(
        reference
      );

    // ====================================
    // 11. 기준 미저장 상태 안내
    // ====================================

    let notice =
      riskPanel.querySelector(
        ".bike-risk-reference-notice"
      );

    if (!notice) {
      notice =
        document.createElement("p");

      notice.className =
        "small-note " +
        "bike-risk-reference-notice";

      riskPanel.appendChild(notice);
    }

    if (!reference) {
      notice.hidden = false;

      notice.textContent =
        "현재 저장된 서울 전체 통합 " +
        "위험도 기준이 없어. " +
        "사고 지도나 사고 분석 페이지에서 " +
        "데이터를 조회하면 위험도 기준을 " +
        "계산할 수 있어. " +
        "다만 일부 자료가 누락된 경우에는 " +
        "통합 기준이 저장되지 않을 수 있어.";

    } else {
      notice.hidden = true;
      notice.textContent = "";
    }

  }
);
