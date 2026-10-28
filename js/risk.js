
/*
  BIKE SAFE - 공통 위험도 분석

  적용 페이지:
  - 사고 지도
  - 사고 분석
  - 프로젝트 소개

  분석 대상:
  - 서울 25개 자치구
  - 2021년 ~ 2023년

  주의:
  기존 위험도 점수 계산 공식과
  50%, 80% 백분위 기준은 변경하지 않습니다.
*/

// ========================================
// 1. 분석 연도
// ========================================

export const RISK_YEARS = [
  "2021",
  "2022",
  "2023"
];

// ========================================
// 2. 서울 자치구 코드
// ========================================

export const RISK_DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

// ========================================
// 3. 캐시 설정
// ========================================

// data.js와 호환되는 데이터 캐시 이름
export const RISK_CACHE_PREFIX = "bicycle_v3_";

// 서울 전체 통합 위험도 기준 캐시
const REFERENCE_CACHE_KEY =
  "bike_safe_reference_v1";

// 위험도 기준 보관 기간: 24시간
const REFERENCE_DURATION =
  24 * 60 * 60 * 1000;

// ========================================
// 4. 숫자 및 표시 형식
// ========================================

export function riskNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

export function riskFormat(value) {
  return riskNumber(value)
    .toLocaleString("ko-KR");
}

// ========================================
// 5. 사고 위험도 점수 계산
// ========================================

/*
  기존 가중치 유지

  사고 건수       × 3
  사망자 수       × 10
  중상자 수       × 5
  경상자 수       × 2
  부상신고자 수   × 1

  GAS에서 riskScore를 제공하면
  기존 방식대로 해당 점수를 우선 사용합니다.
*/

export function getAccidentScore(item) {
  if (!item || typeof item !== "object") {
    return 0;
  }

  if (
    item.riskScore !== undefined &&
    item.riskScore !== null &&
    item.riskScore !== ""
  ) {
    return riskNumber(item.riskScore);
  }

  return (
    riskNumber(item.accidentCount) * 3 +
    riskNumber(item.deathCount) * 10 +
    riskNumber(item.seriousCount) * 5 +
    riskNumber(item.minorCount) * 2 +
    riskNumber(item.reportedInjuryCount)
  );
}

// ========================================
// 6. 연도별 사고 기록 통합
// ========================================

/*
  동일 자치구 + 동일 사고지역 이름을
  하나의 사고지역으로 묶습니다.

  예시:
  2021년 강남구 A교차로
  2022년 강남구 A교차로
  2023년 강남구 A교차로

  → 강남구 A교차로 하나로 통합

  records에는 연도별 기록을 보관합니다.
*/

export function groupRiskAccidents(items) {
  const groups = new Map();

  if (!Array.isArray(items)) {
    return [];
  }

  const fields = [
    "accidentCount",
    "casualtyCount",
    "deathCount",
    "seriousCount",
    "minorCount",
    "reportedInjuryCount"
  ];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const name = String(
      item.name || ""
    ).trim();

    const normalizedName =
      name.replace(/\s+/g, "");

    if (!normalizedName) {
      continue;
    }

    const districtCode = String(
      item.districtCode || ""
    );

    const key =
      districtCode + "|" + normalizedName;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        districtCode,
        latitude: null,
        longitude: null,
        accidentCount: 0,
        casualtyCount: 0,
        deathCount: 0,
        seriousCount: 0,
        minorCount: 0,
        reportedInjuryCount: 0,
        riskScore: 0,
        records: {}
      });
    }

    const group = groups.get(key);

    const year = String(
      item.year || ""
    );

    if (!group.records[year]) {
      group.records[year] = {
        accidentCount: 0,
        casualtyCount: 0,
        deathCount: 0,
        seriousCount: 0,
        minorCount: 0,
        reportedInjuryCount: 0,
        riskScore: 0
      };
    }

    // 사고 및 인명피해 합산
    for (const field of fields) {
      const value = riskNumber(
        item[field]
      );

      group[field] += value;
      group.records[year][field] += value;
    }

    // 위험도 점수 합산
    const score = getAccidentScore(item);

    group.riskScore += score;

    group.records[year].riskScore += score;

    // 좌표가 유효한 경우만 사용
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);

    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= 33 &&
      latitude <= 39 &&
      longitude >= 124 &&
      longitude <= 132
    ) {
      group.latitude = latitude;
      group.longitude = longitude;
    }
  }

  return Array.from(groups.values());
}

// ========================================
// 7. 백분위수 계산
// ========================================

/*
  기존 최근접 순위 방식 사용

  50백분위: 하위 50% 경계
  80백분위: 하위 80% 경계

  동일 점수는 동일 위험등급으로 분류
*/

export function calculatePercentile(
  sortedScores,
  percentile
) {
  if (
    !Array.isArray(sortedScores) ||
    sortedScores.length === 0
  ) {
    return null;
  }

  // 입력 범위를 0~1로 제한
  const input = Number(percentile);

  if (!Number.isFinite(input)) {
    return null;
  }

  const p = Math.min(
    1,
    Math.max(0, input)
  );

  const index = Math.min(
    sortedScores.length - 1,
    Math.max(
      0,
      Math.ceil(sortedScores.length * p) - 1
    )
  );

  return sortedScores[index];
}

// ========================================
// 8. 위험도 분류 기준 생성
// ========================================

/*
  전달받은 사고지역 점수를 기준으로
  위험등급의 경계값을 생성합니다.

  전체 연도:
    서울 전체 2021~2023년 점수 기준

  단일 연도:
    지도 페이지에서 해당 연도 데이터로
    별도 계산할 수 있습니다.
*/

export function createRiskReference(groups) {
  if (
    !Array.isArray(groups) ||
    groups.length === 0
  ) {
    return null;
  }

  const scores = groups
    .filter(
      item =>
        item &&
        typeof item === "object"
    )
    .map(
      item => riskNumber(item.riskScore)
    )
    .sort((a, b) => a - b);

  if (scores.length === 0) {
    return null;
  }

  return {
    method: "nearest-rank",
    years: [...RISK_YEARS],
    area: "서울 전체",
    spotCount: scores.length,
    p50: calculatePercentile(
      scores,
      0.50
    ),
    p80: calculatePercentile(
      scores,
      0.80
    ),
    calculatedAt: Date.now()
  };
}

// ========================================
// 9. 위험도 기준 유효성 검사
// ========================================

function isValidReference(reference) {
  if (
    !reference ||
    typeof reference !== "object"
  ) {
    return false;
  }

  if (reference.method !== "nearest-rank") {
    return false;
  }

  if (
    !Number.isFinite(reference.p50) ||
    !Number.isFinite(reference.p80)
  ) {
    return false;
  }

  // 경계값의 순서가 뒤집힌 캐시 차단
  if (reference.p50 > reference.p80) {
    return false;
  }

  if (
    !Number.isFinite(reference.spotCount) ||
    reference.spotCount <= 0
  ) {
    return false;
  }

  if (!Number.isFinite(reference.calculatedAt)) {
    return false;
  }

  // 저장 날짜가 미래이거나 만료되면 사용하지 않음
  const age =
    Date.now() - reference.calculatedAt;

  if (
    age < 0 ||
    age > REFERENCE_DURATION
  ) {
    return false;
  }

  // 기존 3개년 통합 기준만 캐시에서 사용
  if (
    !Array.isArray(reference.years) ||
    reference.years.length !==
      RISK_YEARS.length
  ) {
    return false;
  }

  const matches = RISK_YEARS.every(
    (year, index) =>
      String(reference.years[index]) === year
  );

  return matches;
}

// ========================================
// 10. 위험도 기준 저장
// ========================================

export function saveRiskReference(reference) {
  if (!isValidReference(reference)) {
    return;
  }

  try {
    localStorage.setItem(
      REFERENCE_CACHE_KEY,
      JSON.stringify(reference)
    );
  } catch (error) {
    console.warn(
      "위험도 기준 저장 생략",
      error
    );
  }
}

// ========================================
// 11. 저장된 위험도 기준 읽기
// ========================================

export function readRiskReference() {
  try {
    const text = localStorage.getItem(
      REFERENCE_CACHE_KEY
    );

    if (!text) {
      return null;
    }

    const reference = JSON.parse(text);

    if (!isValidReference(reference)) {
      return null;
    }

    return reference;
  } catch (error) {
    return null;
  }
}

// ========================================
// 12. 위험도 등급 분류
// ========================================

/*
  기존 기준 유지

  주의:
    점수 <= 50백분위

  높음:
    50백분위 초과
    80백분위 이하

  매우 높음:
    80백분위 초과
*/

export function getRiskLevel(
  score,
  reference
) {
  if (!reference) {
    return "unknown";
  }

  const value = riskNumber(score);

  if (value <= reference.p50) {
    return "low";
  }

  if (value <= reference.p80) {
    return "medium";
  }

  return "high";
}

// ========================================
// 13. 위험도 한글 표시
// ========================================

export function getRiskLabel(
  score,
  reference
) {
  const level = getRiskLevel(
    score,
    reference
  );

  if (level === "low") {
    return "주의";
  }

  if (level === "medium") {
    return "높음";
  }

  if (level === "high") {
    return "매우 높음";
  }

  return "기준 계산 중";
}

// ========================================
// 14. 위험도 점수 구간 표시
// ========================================

export function getRiskRanges(reference) {
  if (!reference) {
    return {
      low: "기준 준비 중",
      medium: "기준 준비 중",
      high: "기준 준비 중"
    };
  }

  const p50 = reference.p50;
  const p80 = reference.p80;

  return {
    low:
      `${riskFormat(p50)}점 이하`,

    medium:
      p50 === p80
        ? "해당 점수 구간 없음"
        : (
          `${riskFormat(p50)}점 초과 ~ ` +
          `${riskFormat(p80)}점 이하`
        ),

    high:
      `${riskFormat(p80)}점 초과`
  };
}

// ========================================
// 15. 프로젝트 소개용 위험도 설명
// ========================================

export function getRiskDescription(reference) {
  if (!reference) {
    return (
      "서울 전체 데이터 기준을 " +
      "계산하지 못했어요."
    );
  }

  return (
    `서울 전체 ${riskFormat(reference.spotCount)}곳 기준 · ` +
    `50백분위 ${riskFormat(reference.p50)}점 · ` +
    `80백분위 ${riskFormat(reference.p80)}점`
  );
}
