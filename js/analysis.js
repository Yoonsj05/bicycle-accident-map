
/*
  BIKE SAFE - 자전거 사고 분석 페이지

  기존 기능:
  - 서울 전체 및 자치구별 통계
  - 사고지역 수 / 사고 건수 / 사상자 수
  - 위험지역 TOP 5
  - 연도별 사고 및 사상자 그래프
  - 연도별 상세 통계표
  - 공통 데이터 캐시 활용

  이번 최적화:
  - 자치구별 조회 진행 상황 정확히 계산
  - 자료 없음 / 요청 실패 구분
  - 서울 전체 동일한 위험도 기준 적용
  - 동점 순위 안정화
  - 중복 화면 갱신 감소

  HTML / CSS 변경 없음
*/

// ========================================
// 1. 공통 변수
// ========================================

let tools = null;
let snapshot = null;

let reference = null;
let partial = true;

let renderTimer = null;

const $ = id => document.getElementById(id);

function num(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

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

function write(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = String(value);
  }
}

// ========================================
// 2. 선택한 지역 확인
// ========================================

function selectedDistrict() {
  return $("analysisDistrict")?.value || "all";
}

function selectedDistrictName() {
  const select = $("analysisDistrict");

  if (!select) {
    return "서울 전체";
  }

  const option = select.selectedOptions[0];

  return option?.textContent || "서울 전체";
}

function matchingDistrict(job) {
  const district = selectedDistrict();

  return (
    district === "all" ||
    String(job.district) === district
  );
}

// ========================================
// 3. 선택한 지역 데이터
// ========================================

function selectedItems() {
  if (!snapshot) {
    return [];
  }

  const district = selectedDistrict();

  if (district === "all") {
    return snapshot.items;
  }

  return snapshot.items.filter(
    item =>
      String(item.districtCode) === district
  );
}

// ========================================
// 4. 조회 상태 계산
// ========================================

function getProgress() {
  if (!snapshot || !tools) {
    return {
      total: 0,
      completed: 0,
      nodata: 0,
      failed: 0,
      pending: 0,
      finished: false
    };
  }

  const success = snapshot.success.filter(
    matchingDistrict
  ).length;

  const nodata = snapshot.nodata.filter(
    matchingDistrict
  ).length;

  const failed = snapshot.failed.filter(
    matchingDistrict
  ).length;

  const total =
    selectedDistrict() === "all"
      ? snapshot.total
      : tools.RISK_YEARS.length;

  const completed = success + nodata + failed;

  return {
    total,
    completed,
    nodata,
    failed,
    pending: Math.max(0, total - completed),
    finished: completed >= total
  };
}

// ========================================
// 5. 서울 전체 위험도 기준
// ========================================

function updateRiskReference(allGroups) {
  const calculated = allGroups.length
    ? tools.createRiskReference(allGroups)
    : null;

  const saved = tools.readRiskReference();

  // 3개년 전체 데이터를 기준으로 계산
  // 지역 필터와 상관없이 동일한 기준 사용
  const fullyReceived =
    snapshot.finished &&
    snapshot.failed.length === 0 &&
    snapshot.nodata.length === 0;

  if (fullyReceived && calculated) {
    reference = calculated;
    partial = false;

    const changed =
      !saved ||
      saved.p50 !== calculated.p50 ||
      saved.p80 !== calculated.p80 ||
      saved.spotCount !== calculated.spotCount;

    if (changed) {
      tools.saveRiskReference(calculated);
    }

    return;
  }

  // 조회 실패 또는 자료 없음이 있는 경우
  // 완전한 통계라고 단정하지 않음
  reference = calculated || saved;

  partial = true;
}

// ========================================
// 6. 위험지역 TOP 5
// ========================================

function renderRanking(groups) {
  const target = $("analysisRanking");

  if (!target) {
    return;
  }

  target.replaceChildren();

  // 기존 위험도 점수 기준 유지
  const ranked = [...groups]
    .sort((a, b) => {
      const scoreDifference =
        num(b.riskScore) - num(a.riskScore);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      // 같은 점수라면 이름순으로 정렬
      return String(a.name).localeCompare(
        String(b.name),
        "ko"
      );
    })
    .slice(0, 5);

  if (ranked.length === 0) {
    target.appendChild(
      makeElement(
        "p",
        "analytics-empty",
        "아직 조회된 자전거 사고지역이 없어요."
      )
    );

    return;
  }

  const maxScore = Math.max(
    1,
    ...ranked.map(
      item => num(item.riskScore)
    )
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

    const riskLabel = tools.getRiskLabel(
      item.riskScore,
      reference
    );

    const info = makeElement(
      "p",
      "ranking-info",
      `사고 ${fmt(item.accidentCount)}건` +
      ` · 사상자 ${fmt(item.casualtyCount)}명` +
      ` · ${riskLabel}`
    );

    const background = makeElement(
      "div",
      "bar-background"
    );

    const fill = makeElement(
      "div",
      "bar"
    );

    const percentage =
      num(item.riskScore) / maxScore * 100;

    fill.style.width =
      Math.max(
        0,
        Math.min(100, percentage)
      ) + "%";

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
// 7. 연도별 사고 통계 계산
// ========================================

function calculateYearly(items) {
  const yearly = {};

  const district = selectedDistrict();

  // 연도별 조회 성공/실패 여부도 확인
  for (const year of tools.RISK_YEARS) {
    const matches = job =>
      String(job.year) === String(year) &&
      (
        district === "all" ||
        String(job.district) === district
      );

    yearly[year] = {
      accidents: 0,
      casualties: 0,
      score: 0,
      success: snapshot.success.filter(matches).length,
      nodata: snapshot.nodata.filter(matches).length,
      failed: snapshot.failed.filter(matches).length
    };

    const total =
      district === "all"
        ? tools.RISK_DISTRICTS.length
        : 1;

    const completed =
      yearly[year].success +
      yearly[year].nodata +
      yearly[year].failed;

    yearly[year].pending =
      Math.max(0, total - completed);

    // 통계 일부가 누락되어 있으면 표시
    yearly[year].incomplete =
      yearly[year].failed > 0 ||
      yearly[year].nodata > 0 ||
      yearly[year].pending > 0;
  }

  // 정상 조회된 데이터만 합산
  for (const item of items) {
    const year = String(item.year);

    if (!yearly[year]) {
      continue;
    }

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
// 8. 연도별 막대그래프
// ========================================

function renderChart(yearly) {
  const target = $("yearlyChart");

  if (!target) {
    return;
  }

  target.replaceChildren();

  const maxValue = Math.max(
    1,
    ...tools.RISK_YEARS.flatMap(year => [
      yearly[year].accidents,
      yearly[year].casualties
    ])
  );

  for (const year of tools.RISK_YEARS) {
    const record = yearly[year];

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
        value: record.accidents,
        className: "blue",
        label: "사고 건수"
      },
      {
        value: record.casualties,
        className: "red",
        label: "사상자 수"
      }
    ];

    for (const item of series) {
      const wrapper = makeElement(
        "div",
        "year-bar-wrap"
      );

      const bar = makeElement(
        "div",
        "year-bar " + item.className
      );

      // 기존 그래프 높이 계산 방식 유지
      const height = Math.max(
        2,
        item.value / maxValue * 100
      );

      bar.style.height = height + "%";

      // 일부 자료가 없으면 별표 표시
      const valueText =
        fmt(item.value) +
        (record.incomplete ? "*" : "");

      bar.appendChild(
        makeElement(
          "span",
          "year-bar-value",
          valueText
        )
      );

      bar.title =
        `${year}년 ${item.label}: ` +
        fmt(item.value) +
        (
          record.incomplete
            ? " (일부 조회 자료 누락 가능)"
            : ""
        );

      wrapper.appendChild(bar);
      bars.appendChild(wrapper);
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
// 9. 연도별 통계표
// ========================================

function renderTable(yearly) {
  const target = $("yearlyTableBody");

  if (!target) {
    return;
  }

  target.replaceChildren();

  for (const year of tools.RISK_YEARS) {
    const record = yearly[year];

    const tr = document.createElement("tr");

    const values = [
      year + (record.incomplete ? " *" : ""),
      fmt(record.accidents) + "건",
      fmt(record.casualties) + "명",
      fmt(record.score) + "점"
    ];

    for (const value of values) {
      tr.appendChild(
        makeElement(
          "td",
          "",
          value
        )
      );
    }

    if (record.incomplete) {
      tr.title =
        "일부 자료가 조회 중이거나 " +
        "자료 없음 또는 요청 실패 상태입니다.";
    }

    target.appendChild(tr);
  }
}

// ========================================
// 10. 분석 페이지 상태 표시
// ========================================

function renderStatus(progress) {
  const regionName = selectedDistrictName();

  const text = progress.finished
    ? (
      `${regionName} 분석 완료` +
      ` · 자료 없음 ${progress.nodata}건` +
      ` · 요청 실패 ${progress.failed}건`
    )
    : (
      `${regionName} 분석 중 ` +
      `${progress.completed}/${progress.total}건` +
      " · 저장된 데이터 우선 표시"
    );

  write("analysisStatus", text);
}

// ========================================
// 11. 분석 범위 및 주의 문구
// ========================================

function renderCoverage(progress) {
  const referenceText =
    tools.getRiskDescription(reference);

  const standardText = partial
    ? " · 조회된 자료 기준의 임시 위험도 분류."
    : " · 서울 전체 동일한 위험도 기준.";

  const progressText =
    ` · 선택 지역 조회 ` +
    `${progress.completed}/${progress.total}건` +
    `, 자료 없음 ${progress.nodata}건` +
    `, 실패 ${progress.failed}건.`;

  const caution =
    " 조회되지 않은 기록은 통계 합계에 " +
    "포함되지 않습니다. " +
    "별표(*)는 일부 자료가 조회 중이거나 " +
    "누락되었을 수 있음을 뜻합니다.";

  write(
    "analysisCoverage",
    referenceText +
    standardText +
    progressText +
    caution
  );
}

// ========================================
// 12. 사고 분석 전체 갱신
// ========================================

function render() {
  if (!tools || !snapshot) {
    return;
  }

  // 위험도 기준은 서울 전체 데이터로 계산
  const allGroups =
    tools.groupRiskAccidents(snapshot.items);

  updateRiskReference(allGroups);

  // 현재 선택한 지역의 데이터
  const items = selectedItems();

  const groups =
    selectedDistrict() === "all"
      ? allGroups
      : tools.groupRiskAccidents(items);

  // 요약 통계
  write(
    "analysisSpotCount",
    fmt(groups.length)
  );

  write(
    "analysisAccidentCount",
    fmt(
      items.reduce(
        (total, item) =>
          total + num(item.accidentCount),
        0
      )
    )
  );

  write(
    "analysisCasualtyCount",
    fmt(
      items.reduce(
        (total, item) =>
          total + num(item.casualtyCount),
        0
      )
    )
  );

  // TOP 5 위험지역
  renderRanking(groups);

  // 연도별 그래프 및 표
  const yearly = calculateYearly(items);

  renderChart(yearly);
  renderTable(yearly);

  // 진행 상태와 데이터 범위
  const progress = getProgress();

  renderStatus(progress);
  renderCoverage(progress);
}

// ========================================
// 13. 데이터 변경 시 갱신 예약
// ========================================

function scheduleRender(next) {
  snapshot = next;

  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  // 데이터 로딩이 끝났으면 즉시 표시
  if (next.finished || !next.loading) {
    render();
    return;
  }

  // API 응답이 연속으로 들어오면
  // 화면을 지나치게 자주 그리지 않음
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 180);
}

// ========================================
// 14. 페이지 시작
// ========================================

window.addEventListener("load", async () => {
  // 분석 페이지가 아니면 실행하지 않음
  if (
    !$("analysisDistrict") ||
    !$("analysisStatus")
  ) {
    return;
  }

  try {
    // 공통 위험도 계산 도구
    tools = await import("./risk.js");

    // 지도와 동일한 데이터 관리자
    const shared = await import("./data.js");

    // 자치구 변경 시 결과 갱신
    $("analysisDistrict").addEventListener(
      "change",
      render
    );

    // 기존 분석 버튼 유지
    const analyzeButton = $("analyzeButton");

    if (analyzeButton) {
      analyzeButton.addEventListener(
        "click",
        render
      );
    }

    // 저장된 데이터부터 화면에 표시
    shared.subscribe(scheduleRender);

    // 부족한 데이터만 조회
    shared.startLoading();

  } catch (error) {
    console.error(
      "BIKE SAFE 사고 분석 초기화 오류:",
      error
    );

    write(
      "analysisStatus",
      "사고 분석 데이터를 불러오지 못했습니다."
    );
  }
});
