/** Standard governorate names for addresses even before courier rates are loaded. */
export const EGYPT_GOVERNORATES = [
  "القاهرة", "الجيزة", "القليوبية", "الإسكندرية", "البحيرة", "مطروح",
  "كفر الشيخ", "الغربية", "المنوفية", "الدقهلية", "دمياط", "الشرقية",
  "بورسعيد", "الإسماعيلية", "السويس", "شمال سيناء", "جنوب سيناء",
  "البحر الأحمر", "الفيوم", "بني سويف", "المنيا", "أسيوط", "سوهاج",
  "قنا", "الأقصر", "أسوان", "الوادي الجديد",
] as const;

export function mgBranchForGovernorate(governorate: string): string {
  return ["القاهرة", "الجيزة", "القليوبية"].includes(governorate.trim()) ? "5" : "1";
}
