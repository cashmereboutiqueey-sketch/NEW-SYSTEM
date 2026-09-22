import { describe, it, expect } from "vitest";
import { arabicWholeNumber, amountInArabicWords } from "./arabic-words";

/** The line an invoice is checked against when the figure is argued over. */

describe("whole numbers in words", () => {
  it("says the small ones", () => {
    expect(arabicWholeNumber(0)).toBe("صفر");
    expect(arabicWholeNumber(1)).toBe("واحد");
    expect(arabicWholeNumber(9)).toBe("تسعة");
    expect(arabicWholeNumber(10)).toBe("عشرة");
  });

  it("says the teens as their own words, not as ten and something", () => {
    expect(arabicWholeNumber(11)).toBe("أحد عشر");
    expect(arabicWholeNumber(15)).toBe("خمسة عشر");
    expect(arabicWholeNumber(19)).toBe("تسعة عشر");
  });

  it("puts the unit before the ten, which is the Arabic order", () => {
    expect(arabicWholeNumber(21)).toBe("واحد وعشرون");
    expect(arabicWholeNumber(45)).toBe("خمسة وأربعون");
    expect(arabicWholeNumber(99)).toBe("تسعة وتسعون");
  });

  it("gives the hundreds their own words", () => {
    // Not "ثلاثة مائة": these are single words and always have been.
    expect(arabicWholeNumber(100)).toBe("مائة");
    expect(arabicWholeNumber(200)).toBe("مئتان");
    expect(arabicWholeNumber(300)).toBe("ثلاثمائة");
    expect(arabicWholeNumber(600)).toBe("ستمائة");
    expect(arabicWholeNumber(900)).toBe("تسعمائة");
  });

  it("joins a hundred to what follows it", () => {
    expect(arabicWholeNumber(625)).toBe("ستمائة وخمسة وعشرون");
    expect(arabicWholeNumber(101)).toBe("مائة وواحد");
  });

  it("counts thousands in the singular, the dual and the plural", () => {
    expect(arabicWholeNumber(1000)).toBe("ألف");
    expect(arabicWholeNumber(2000)).toBe("ألفان");
    expect(arabicWholeNumber(3000)).toBe("ثلاثة آلاف");
    expect(arabicWholeNumber(10_000)).toBe("عشرة آلاف");
  });

  it("returns to the singular above ten thousand, which is the rule that catches everybody", () => {
    expect(arabicWholeNumber(11_000)).toBe("أحد عشر ألف");
    expect(arabicWholeNumber(50_000)).toBe("خمسون ألف");
  });

  it("builds a full figure out of its parts", () => {
    expect(arabicWholeNumber(1500)).toBe("ألف وخمسمائة");
    expect(arabicWholeNumber(2350)).toBe("ألفان وثلاثمائة وخمسون");
    expect(arabicWholeNumber(1_000_000)).toBe("مليون");
    expect(arabicWholeNumber(2_500_000)).toBe("مليونان وخمسمائة ألف");
  });
});

describe("the line beneath the total", () => {
  it("writes the receipt in the photograph", () => {
    expect(amountInArabicWords(600)).toBe("فقط ستمائة جنيه مصرى لا غير");
  });

  it("closes the figure at both ends so nothing can be added to it", () => {
    const said = amountInArabicWords(1250);
    expect(said.startsWith("فقط ")).toBe(true);
    expect(said.endsWith(" لا غير")).toBe(true);
  });

  it("names piastres only when there are any", () => {
    expect(amountInArabicWords(600)).not.toContain("قرش");
    expect(amountInArabicWords(600.5)).toBe("فقط ستمائة جنيه مصرى وخمسون قرش لا غير");
  });

  it("says piastres alone when that is the whole of it", () => {
    expect(amountInArabicWords(0.75)).toBe("فقط خمسة وسبعون قرش لا غير");
  });

  it("rounds to the piastre rather than trailing a float", () => {
    expect(amountInArabicWords(600.004)).toBe("فقط ستمائة جنيه مصرى لا غير");
    expect(amountInArabicWords("1250.50")).toContain("خمسون قرش");
  });

  it("says nothing sensible about nothing, which is still a sum", () => {
    expect(amountInArabicWords(0)).toBe("فقط صفر جنيه مصرى لا غير");
  });

  it("does not silently drop a minus, however it got there", () => {
    expect(amountInArabicWords(-600)).toContain("سالب");
  });
});
