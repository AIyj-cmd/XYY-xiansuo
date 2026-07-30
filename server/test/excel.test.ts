import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';

test('升级后的 Excel 依赖仍能生成并读取工作簿', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('线索');
  sheet.addRow(['联系人', '手机号']);
  sheet.addRow(['测试客户', '13800000000']);

  const output = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(Uint8Array.from(output).buffer);

  assert.equal(reloaded.getWorksheet('线索')?.getCell('A2').value, '测试客户');
  assert.equal(reloaded.getWorksheet('线索')?.getCell('B2').value, '13800000000');
});
