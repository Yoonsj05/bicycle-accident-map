
/*
  BIKE SAFE 자전거 사고 분석

  지도와 공통 데이터 캐시를 사용합니다.

  기능:
  - 저장된 사고 데이터 즉시 표시
  - 지역별 사고 통계
  - 위험지역 TOP 5
  - 연도별 사고 그래프
  - 연도별 통계 표

  HTML/CSS 변경 불필요
*/

// ========================================
// 1. 기본 변수 및 함수
// ========================================

let tools;
let snapshot;
let reference;

let partial = true;
let grouped = [];
let renderTimer = null;

const $ = id => document.getElementById(id);

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const fmt = value =>
  num(value).toLocaleString("ko-KR");

function makeElement(tag, className = "", text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = String(text);
  }

  return element;
}

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = value;
  }
}

// ========================================
// 2. 지역별 데이터 선택
// ========================================

function selectedData() {
  const region = $("analysisDistrict").value;

  return region === "all"
    ? snapshot.items
    : snapshot.items.filter(
        item => item.districtCode === region
      );
}

function selectedFailures() {
  const region = $("analysisDistrict").value;

  return snapshot.failed.filter(job => {
    return (
      region === "all" ||
      job.district === region
    );
  });
}

// ========================================
// 3. 서울 전체 위험도 기준
// ========================================

function updateRiskReference() {
  const calculated = grouped.length
    ? tools.createRiskReference(grouped)
    : null;

  const saved = tools.readRiskReference();

  const complete =
    snapshot.finished &&
    snapshot.failed.length === 0 &&
    snapshot.nodata.length === 0;

  if (complete && calculated) {
    reference = calculated;
    partial = false;

    if (
      !saved ||
      saved.p50 !== calculated.p50 ||
      saved.p80 !== calculated.p80
    ) {
      tools.saveRiskReference(calculated);
    }

  } else {
    reference = saved || calculated;
    partial = !saved;
  }
}

// ========================================
// 4. 위험지역 TOP 5
// ========================================

function renderRanking(groups) {
  const target = $("analysisRanking");

  if (!target) return;

  target.replaceChildren();

  const ranked = [...groups]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  if (!ranked.length) {
    target.appendChild(
      makeElement(
        "p",
        "analytics-empty",
        "아직 조회된 자전거 사고지역이 없어요."
      )
    );

    return;
  }

  const max = Math.max(
    1,
    ...ranked.map(item => item.riskScore)
  );

  ranked.forEach((item, index) => {
    const row = makeElement(
      "div",
      "ranking-item"
    );

    const title = makeElement(
      "div",
      "ranking-title"
    );

    title.append(
      makeElement(
        "span",
        "",
        `${index + 1}위 · ${item.name}`
      ),
      makeElement(
        "span",
        "",
        fmt(item.riskScore) + "점"
      )
    );

    const info = makeElement(
      "p",
      "ranking-info",
      `사고 ${fmt(item.accidentCount)}건 · ` +
      `사상자 ${fmt(item.casualtyCount)}명 · ` +
      tools.getRiskLabel(
        item.riskScore,
        reference
      )
    );

    const background = makeElement(
      "div",
      "bar-background"
    );

    const fill = makeElement(
      "div",
      "bar"
    );

    fill.style.width =
      (num(item.riskScore) / max * 100) + "%";

    background.appendChild(fill);

    row.append(
      title,
      info,
      background
    );

    target.appendChild(row);
  });
}

// ========================================
// 5. 연도별 통계 계산
// ========================================

function calculateYearly(items, failed) {
  const yearly = {};

  for (const year of tools.RISK_YEARS) {
    yearly[year] = {
      accidents: 0,
      casualties: 0,
      score: 0,
      failed: failed.some(
        job => job.year === year
      )
    };
  }

  for (const item of items) {
    const year = String(item.year);

    if (!yearly[year]) continue;

    yearly[year].accidents +=
      num(item.accidentCount);

    yearly[year].casualties +=
      num(item.casualtyCount);

    yearly[year].score +=
      tools.getAccidentScore(item);
  }

  return yearly;
}

// ========================================
// 6. 연도별 그래프
// ========================================

function renderChart(yearly) {
  const target = $("yearlyChart");

  if (!target) return;

  target.replaceChildren();

  const max = Math.max(
    1,
    ...tools.RISK_YEARS.flatMap(year => [
      yearly[year].accidents,
      yearly[year].casualties
    ])
  );

  for (const year of tools.RISK_YEARS) {
    const item = yearly[year];

    const group = makeElement(
      "div",
      "year-group"
    );

    const bars = makeElement(
      "div",
      "year-bars"
    );

    const series = [
      {
        value: item.accidents,
        className: "blue"
      },
      {
        value: item.casualties,
        className: "red"
      }
    ];

    for (const data of series) {
      const wrap = makeElement(
        "div",
        "year-bar-wrap"
      );

      const bar = makeElement(
        "div",
        "year-bar " + data.className
      );

      bar.style.height =
        Math.max(
          2,
          data.value / max * 100
        ) + "%";

      const label = makeElement(
        "span",
        "year-bar-value",
        fmt(data.value) +
        (item.failed ? "*" : "")
      );

      bar.appendChild(label);
      wrap.appendChild(bar);
      bars.appendChild(wrap);
    }

    group.append(
      bars,
      makeElement(
        "span",
        "year-name",
        year
      )
    );

    target.appendChild(group);
  }
}

// ========================================
// 7. 연도별 통계 표
// ========================================

function renderTable(yearly) {
  const body = $("yearlyTableBody");

  if (!body) return;

  body.replaceChildren();

  for (const year of tools.RISK_YEARS) {
    const item = yearly[year];

    const row = document.createElement("tr");

    const values = [
      year + (item.failed ? " *" : ""),
      fmt(item.accidents) + "건",
      fmt(item.casualties) + "명",
      fmt(item.score) + "점"
    ];

    values.forEach(value => {
      row.appendChild(
        makeElement(
          "td",
          "",
          value
        )
      );
    });

    body.appendChild(row);
  }
}

// ========================================
// 8. 분석 화면 갱신
// ========================================

function renderAnalysis() {
  if (!tools || !snapshot) return;

  // 위험도 기준은 항상 서울 전체 자료로 계산
  grouped = tools.groupRiskAccidents(
    snapshot.items
  );

  updateRiskReference();

  // 통계와 순위는 선택된 지역 기준
  const items = selectedData();
  const failed = selectedFailures();

  const groups = tools.groupRiskAccidents(
    items
  );

  setText(
    "analysisSpotCount",
    fmt(groups.length)
  );

  setText(
    "analysisAccidentCount",
    fmt(
      items.reduce(
        (sum, item) =>
          sum + num(item.accidentCount),
        0
      )
    )
  );

  setText(
    "analysisCasualtyCount",
    fmt(
      items.reduce(
        (sum, item) =>
          sum + num(item.casualtyCount),
        0
      )
    )
  );

  renderRanking(groups);

  const yearly = calculateYearly(
    items,
    failed
  );

  renderChart(yearly);
  renderTable(yearly);

  const selectedOption =
    $("analysisDistrict").selectedOptions[0];

  const region = selectedOption
    ? selectedOption.textContent
    : "서울 전체";

  const status = snapshot.finished
    ? (
      `${region} 분석 완료 · ` +
      `자료 없음 ${snapshot.nodata.length}건 · ` +
      `요청 실패 ${snapshot.failed.length}건`
    )
    : (
      `${region} 분석 중 ` +
      `${snapshot.completed}/${snapshot.total}건 · ` +
      "저장된 데이터 우선 표시"
    );

  setText(
    "analysisStatus",
    status
  );

  const description =
    tools.getRiskDescription(reference) +
    (
      partial
        ? " · 조회된 자료로 계산한 임시 " +
          "위험도 기준."
        : " · 서울 전체 동일한 위험도 기준."
    ) +
    ` · 전체 조회 ` +
    `${snapshot.completed}/${snapshot.total}건, ` +
    `자료 없음 ${snapshot.nodata.length}건, ` +
    `실패 ${snapshot.failed.length}건.` +
    " 조회되지 않은 기록은 통계 " +
    "합계에 포함되지 않습니다.";

  setText(
    "analysisCoverage",
    description
  );
}

// ========================================
// 9. 페이지 시작
// ========================================

window.addEventListener("load", async () => {
  if (
    !$("analysisDistrict") ||
    !$("analysisStatus")
  ) {
    return;
  }

  try {
    tools = await import("./risk.js");

    const shared = await import("./data.js");

    // 지역 선택
    $("analysisDistrict").addEventListener(
      "change",
      renderAnalysis
    );

    // 분석 버튼
    const button = $("analyzeButton");

    if (button) {
      button.addEventListener(
        "click",
        renderAnalysis
      );
    }

    // 저장된 데이터와 새 응답을 함께 반영
    shared.subscribe(next => {
      snapshot = next;

      if (renderTimer) {
        clearTimeout(renderTimer);
      }

      if (next.finished || !next.loading) {
        renderAnalysis();

      } else {
        renderTimer = setTimeout(
          renderAnalysis,
          180
        );
      }
    });

    shared.startLoading();

  } catch (error) {
    console.error(error);

    setText(
      "analysisStatus",
      "공통 데이터 파일을 " +
      "불러오지 못했어요."
    );
  }
});
