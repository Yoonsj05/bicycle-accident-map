
/*
  BIKE SAFE - 공통 위험도 분석
  서울 전체 2021~2023년 데이터 기준
  지도 / 사고 분석 / 프로젝트 소개 공통 사용
*/

export const RISK_YEARS = ["2021", "2022", "2023"];

export const RISK_DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

export const RISK_CACHE_PREFIX = "bicycle_v3_";

const REFERENCE_CACHE_KEY = "bike_safe_reference_v1";
const REFERENCE_DURATION = 24 * 60 * 60 * 1000;

export function riskNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function riskFormat(value) {
  return riskNumber(value).toLocaleString("ko-KR");
}

// 위험도 점수는 기존 계산 공식과 동일하게 유지
export function getAccidentScore(item) {
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

// 지역명과 자치구를 기준으로 여러 연도 기록 통합
export function groupRiskAccidents(items) {
  const groups = new Map();

  for (const item of items) {
    const name = String(item.name || "").trim();
    const normalizedName = name.replace(/\s+/g, "");

    if (!normalizedName) continue;

    const key =
      String(item.districtCode || "") +
      "|" +
      normalizedName;

    if (!groups.has(key)) {
      groups.set(key, {
        key: key,
        name: name,
        districtCode: String(item.districtCode || ""),
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
    const year = String(item.year || "");

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

    const fields = [
      "accidentCount",
      "casualtyCount",
      "deathCount",
      "seriousCount",
      "minorCount",
      "reportedInjuryCount"
    ];

    for (const field of fields) {
      const value = riskNumber(item[field]);

      group[field] += value;
      group.records[year][field] += value;
    }

    const score = getAccidentScore(item);

    group.riskScore += score;
    group.records[year].riskScore += score;

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

// 최근접 순위 백분위수 계산
export function calculatePercentile(sortedScores, percentile) {
  if (!sortedScores.length) return null;

  const index = Math.max(
    0,
    Math.ceil(sortedScores.length * percentile) - 1
  );

  return sortedScores[index];
}

// 서울 전체의 정확한 데이터가 준비됐을 때만 호출
export function createRiskReference(groups) {
  if (!groups.length) return null;

  const scores = groups
    .map(item => riskNumber(item.riskScore))
    .sort((a, b) => a - b);

  return {
    method: "nearest-rank",
    years: [...RISK_YEARS],
    area: "서울 전체",
    spotCount: scores.length,
    p50: calculatePercentile(scores, 0.50),
    p80: calculatePercentile(scores, 0.80),
    calculatedAt: Date.now()
  };
}

export function saveRiskReference(reference) {
  if (!reference) return;

  try {
    localStorage.setItem(
      REFERENCE_CACHE_KEY,
      JSON.stringify(reference)
    );
  } catch (error) {
    console.warn("위험도 기준 저장 생략", error);
  }
}

export function readRiskReference() {
  try {
    const text = localStorage.getItem(
      REFERENCE_CACHE_KEY
    );

    if (!text) return null;

    const reference = JSON.parse(text);

    if (
      !reference ||
      reference.method !== "nearest-rank" ||
      !Number.isFinite(reference.p50) ||
      !Number.isFinite(reference.p80) ||
      !Number.isFinite(reference.calculatedAt) ||
      Date.now() - reference.calculatedAt >
        REFERENCE_DURATION
    ) {
      return null;
    }

    return reference;
  } catch (error) {
    return null;
  }
}

// 같은 점수는 반드시 같은 등급
export function getRiskLevel(score, reference) {
  if (!reference) return "unknown";

  const value = riskNumber(score);

  if (value <= reference.p50) return "low";
  if (value <= reference.p80) return "medium";

  return "high";
}

export function getRiskLabel(score, reference) {
  const level = getRiskLevel(score, reference);

  if (level === "low") return "주의";
  if (level === "medium") return "높음";
  if (level === "high") return "매우 높음";

  return "기준 계산 중";
}

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
    low: `${riskFormat(p50)}점 이하`,
    medium: p50 === p80
      ? "해당 점수 구간 없음"
      : `${riskFormat(p50)}점 초과 ~ ${riskFormat(p80)}점 이하`,
    high: `${riskFormat(p80)}점 초과`
  };
}

export function getRiskDescription(reference) {
  if (!reference) {
    return "서울 전체 데이터 기준을 계산하지 못했어요.";
  }

  return (
    `서울 전체 ${riskFormat(reference.spotCount)}곳 기준 · ` +
    `50백분위 ${riskFormat(reference.p50)}점 · ` +
    `80백분위 ${riskFormat(reference.p80)}점`
  );
}
