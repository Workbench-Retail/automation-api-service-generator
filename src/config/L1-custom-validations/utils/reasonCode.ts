type ReasonCode = {
  Reason: string
  RTO?: string
  USED_BY: string
  'Cause of cancellation & hence cost attributed to?'?: string
  'Applicable for part cancel?'?: string
}

type ReasonCodes = {
  [reasonId: string]: ReasonCode
}
export const reasonCodes: ReasonCodes = {
  '002': {
    Reason: 'One or more items in the order not available',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
   
  },
  '021': {
    Reason: 'Store not responsive',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    'Applicable for part cancel?': 'No',
  },
  '022': {
    Reason: 'Technical issue in merchant device',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
  },
  '023': {
    Reason: 'Order received during non-operational hours',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',

  },
  '024': {
    Reason: 'Order received during store rush',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    
     
  },
  '051': {
    Reason: 'Store is not accepting order',
    USED_BY: 'BNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    
   
  },
  '011': {
    Reason: "Retail buyer not found / can't be contacted",
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    
  },
  '013': {
    Reason: "Retail buyer can't / doesn't want to accept delivery",
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    
  },
  '014': {
    Reason: 'Delivery address incorrect or not found',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    
  },
  '016': {
    Reason: 'Force majeure (accident / strike / law & order situation, etc)',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    
     
  },
  '018': {
    Reason: 'Order not serviceable',
    USED_BY: 'SNP',
  },
  '052': {
    Reason: 'Order / fulfillment not received as per O2D TAT',
    USED_BY: 'BNP',
   
  },
  '053': {
    Reason: 'Buyer wants to modify address / other order details',
    USED_BY: 'BNP',

  },
  '998': {
    Reason: 'Order confirmation failure',
    USED_BY: 'SNP',

  },
  '999': {
    Reason: 'Order confirmation failure',
    USED_BY: 'BNP',
   
  },
};


export const return_request_reasonCodes =['001', '002', '003', '004', '005'];
export const partcancel_return_reasonCodes =['002','012'];
export const return_rejected_request_reasonCodes =['001', '002', '003', '004', '005','007','008'];
export const condition_id=["001", "002", "003"] // "001" (proper working condition without damages), "002" (proper working condition with damages), "003" (not working);
export const delivery_delay_reasonCodes = ['001', '002', '003', '004', '005','007','008'];