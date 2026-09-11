/** Tujuan: Verifikasi diskon/bonus dan penolakan mismatch faktur sebelum mengakui realisasi.
 * Caller: node --experimental-strip-types --test lib/program-realization.test.ts.
 * Dependensi: node assert/test, pure payload + verifier. Main Functions: tests.
 * Side Effects: tidak ada database/jaringan/faktur nyata.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInvoicePayload, type InvoiceOrder } from "./accurate-invoice-write.ts";
import { verifyRealization, programSnapshot } from "./program-realization.ts";
const order = (): InvoiceOrder => ({ id:"o1",customer_no:"C-001",outlet:"Toko",channel:"GT",order_date:"2026-09-10",status:"draft",
    sources:[{draft_id:"source",revision:2}],rules:[{id:"p1",name:"Rafaksi"},{id:"p2",name:"Bonus"},{id:"unused",name:"unused"}],
    lines:[{code:"A",unit:"PCS",quantity:"30",price:"10000"}],
    result:{gross:"300000",discount:"141000",net:"159000",lines:[{code:"A",unit:"PCS",quantity:"30",gross:"300000",net:"159000"}],
        applications:[{program_id:"p1",discount:"141000",minimum:"1"},{program_id:"p2",discount:"0",minimum:"30"}],
        bonuses:[{program_id:"p2",code:"A",unit:"PCS",quantity:"1"}]}});
const options={unitIds:new Map([["PCS",1]]),branchId:50,typeAutoNumber:7};
function fixture() {
    const o=programSnapshot(order()), p=buildInvoicePayload(o,options);
    const actual={id:12,customer:{customerNo:o.customer_no},transDate:p.transDate,branchId:50,cashDiscount:0,
        detailItem:p.detailItem.map(l=>({...l,itemUnit:{id:l.itemUnitId,name:"PCS"}}))};
    return {o,p,actual};
}
test("Rp4700/PCS serta bonus masuk payload dan realisasi tanpa biaya bonus karangan",()=>{
    const {o,p,actual}=fixture(); assert.equal(o.rules?.length,2); assert.equal(p.detailItem.length,2);
    assert.equal(p.detailItem[0].itemCashDiscount,4700*30);assert.equal(p.detailItem[1].quantity,1);assert.equal(p.detailItem[1].unitPrice,0);
    const r=verifyRealization(o,p,actual,"12");assert.equal(r.status,"verified");assert.equal(r.discount,141000);
    assert.equal(r.programs.length,2);assert.equal(r.bonuses[0].quantity,1);assert.equal(r.bonuses[0].cost,null);
    assert.deepEqual(verifyRealization(o,p,actual,"12"),r,"repeated verification must be idempotent");
});
test("faktur salah identitas/SKU/qty/satuan/diskon/bonus tidak dihitung",()=>{
    for(const change of [
        (a:ReturnType<typeof fixture>["actual"])=>{a.id=13;},
        (a:ReturnType<typeof fixture>["actual"])=>{a.customer.customerNo="OTHER";},
        (a:ReturnType<typeof fixture>["actual"])=>{a.branchId=99;},
        (a:ReturnType<typeof fixture>["actual"])=>{a.detailItem[0].quantity=29;},
        (a:ReturnType<typeof fixture>["actual"])=>{a.detailItem[0].itemUnit.id=2;},
        (a:ReturnType<typeof fixture>["actual"])=>{a.detailItem[0].itemCashDiscount=0;},
        (a:ReturnType<typeof fixture>["actual"])=>{a.detailItem.pop();},
        (a:ReturnType<typeof fixture>["actual"])=>{a.cashDiscount=10;},
    ]) {const {o,p,actual}=fixture();change(actual);const r=verifyRealization(o,p,actual,"12");assert.equal(r.status,"mismatch");assert.equal(r.discount,null);assert.deepEqual(r.programs,[]);}
});
test("SKU bonus belum dipilih dan versi program hilang ditahan",()=>{
    const o=order();o.result.bonuses![0].code="";assert.throws(()=>buildInvoicePayload(o,options),/Pilih SKU/);
    const {o:good,p,actual}=fixture();delete good.rules;assert.equal(verifyRealization(good,p,actual,"12").status,"mismatch");
});
