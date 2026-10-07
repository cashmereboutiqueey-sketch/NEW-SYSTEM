"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createCourierZoneAction } from "@/app/(app)/shipping/actions";
import { EGYPT_GOVERNORATES } from "@/lib/egypt-governorates";

export type NewCourierZone = { id: string; governorate: string; region: string; price: string };

export function CourierZoneCreate({
  ar,
  governorate,
  onCreated,
}: {
  ar: boolean;
  governorate?: string;
  onCreated?: (zone: NewCourierZone) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chosenGovernorate, setChosenGovernorate] = useState("");
  const [region, setRegion] = useState("");
  const [price, setPrice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const selected = governorate || chosenGovernorate;
  const field = "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await createCourierZoneAction({ governorate: selected, region, price });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onCreated?.(result.zone);
      setSuccess(result.zone.created
        ? ar ? "اتضافت منطقة الشحن." : "Delivery area added."
        : ar ? "المنطقة موجودة بالفعل واتحددت." : "This area already exists and was selected.");
      setRegion("");
      setPrice("");
      setOpen(false);
      if (!onCreated) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <button type="button" onClick={() => { setOpen((value) => !value); setError(null); }} className="font-medium text-rose-deep underline">
        {open ? ar ? "إلغاء" : "Cancel" : ar ? "+ أضف منطقة Flextock" : "+ Add Flextock delivery area"}
      </button>
      {open && (
        <div className="space-y-2 rounded-lg border border-ink-200 bg-panel p-3">
          {!governorate && (
            <label className="block text-ink-600">
              {ar ? "المحافظة" : "Governorate"}
              <select value={chosenGovernorate} onChange={(event) => setChosenGovernorate(event.target.value)} className={`mt-1 ${field}`}>
                <option value="">{ar ? "اختار المحافظة" : "Choose governorate"}</option>
                {EGYPT_GOVERNORATES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          <label className="block text-ink-600">
            {ar ? "اسم المنطقة عند Flextock" : "Area name at Flextock"}
            <input value={region} onChange={(event) => setRegion(event.target.value)} maxLength={120} className={`mt-1 ${field}`} />
          </label>
          <label className="block text-ink-600">
            {ar ? "سعر Flextock للمنطقة (جنيه)" : "Flextock price for this area (EGP)"}
            <input type="number" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} dir="ltr" className={`mt-1 ${field}`} />
          </label>
          <p className="text-ink-500">{ar ? "اكتب السعر المؤكد من Flextock؛ قيمة الشحن على العميل تقدر تعدّلها في الأوردر." : "Enter Flextock's confirmed rate; you can edit what the customer pays on the order."}</p>
          <button type="button" onClick={() => void save()} disabled={pending || !selected || !region.trim() || price.trim() === ""} className="rounded-lg bg-ink-900 px-3 py-2 font-medium text-white disabled:opacity-40">
            {pending ? ar ? "بيحفظ…" : "Saving…" : ar ? "احفظ المنطقة" : "Save area"}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-bad">{error}</p>}
      {success && <p role="status" className="text-good">{success}</p>}
    </div>
  );
}
