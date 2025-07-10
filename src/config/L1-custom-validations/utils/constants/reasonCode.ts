type ReasonCode = {
  Reason: string
  RTO: string
  USED_BY: string
  'Cause of cancellation & hence cost attributed to?': string
  'Applicable for part cancel?': string
}

type ReasonCodes = {
  [reasonId: string]: ReasonCode
}
// export const reasonCodes: ReasonCodes = {
//   '001': {
//     Reason: 'Price of one or more items have changed due to which buyer was asked to make additional payment',
//     RTO: 'No',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'Seller NP (SNP)',
//     'Applicable for part cancel?': 'No',
//   },
//   '002': {
//     Reason: 'One or more items in the Order not available',
//     RTO: 'No',
//     USED_BY: 'SNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'Yes',
//   },
//   '003': {
//     Reason: 'Product available at lower than order price',
//     RTO: 'Yes',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '005': {
//     Reason: 'Merchant rejected the order',
//     RTO: 'No',
//     USED_BY: 'SNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '006': {
//     Reason: 'Order / fulfillment not received as per buyer app TAT SLA',
//     RTO: 'Yes',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP / LSP',
//     'Applicable for part cancel?': 'No',
//   },
//   '007': {
//     Reason: 'Order / fulfillment not received as per buyer app TAT SLA',
//     RTO: 'Yes',
//     USED_BY: 'LBNP',
//     'Cause of cancellation & hence cost attributed to?': 'LSP',
//     'Applicable for part cancel?': 'No',
//   },
//   '008': {
//     Reason: 'Order / fulfillment not ready for pickup',
//     RTO: 'No',
//     USED_BY: 'LSP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '009': {
//     Reason: 'Wrong product delivered',
//     RTO: 'Yes',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '010': {
//     Reason: 'Buyer wants to modify address / other order details',
//     RTO: 'Yes',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '011': {
//     Reason: 'Buyer not found or cannot be contacted',
//     RTO: 'Yes',
//     USED_BY: 'LSP & SNP',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '012': {
//     Reason: 'Buyer does not want product any more',
//     RTO: 'Yes',
//     USED_BY: 'LSP & SNP ',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'Yes',
//   },
//   '013': {
//     Reason: 'Buyer refused to accept delivery',
//     RTO: 'Yes',
//     USED_BY: 'LSP & SNP ',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '014': {
//     Reason: 'Address not found',
//     RTO: 'Yes',
//     USED_BY: 'LSP & SNP ',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '015': {
//     Reason: 'Buyer not available at location',
//     RTO: 'Yes',
//     USED_BY: 'LSP & SNP ',
//     'Cause of cancellation & hence cost attributed to?': 'BNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '016': {
//     Reason: 'Accident / rain / strike / vehicle issues',
//     RTO: 'No',
//     USED_BY: 'LSP',
//     'Cause of cancellation & hence cost attributed to?': 'LSP',
//     'Applicable for part cancel?': 'No',
//   },
//   '017': {
//     Reason: 'Order delivery delayed or not possible',
//     RTO: 'No',
//     USED_BY: 'LSP',
//     'Cause of cancellation & hence cost attributed to?': 'LSP',
//     'Applicable for part cancel?': 'No',
//   },
//   '018': {
//     Reason: 'Delivery pin code not serviceable',
//     RTO: 'No',
//     USED_BY: 'SNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '019': {
//     Reason: 'Pickup pin code not serviceable',
//     RTO: 'No',
//     USED_BY: 'SNP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '020': {
//     Reason: 'Order lost in transit',
//     RTO: 'No',
//     USED_BY: 'LSP & SNP',
//     'Cause of cancellation & hence cost attributed to?': 'LSP',
//     'Applicable for part cancel?': 'No',
//   },
//   '021': {
//     Reason: 'Packed order not complete',
//     RTO: 'No',
//     USED_BY: 'LSP',
//     'Cause of cancellation & hence cost attributed to?': 'SNP',
//     'Applicable for part cancel?': 'No',
//   },
//   '999': {
//     Reason: 'Order confirmation failure',
//     RTO: 'N/A',
//     USED_BY: 'BNP',
//     'Cause of cancellation & hence cost attributed to?': 'N/A',
//     'Applicable for part cancel?': 'N/A',
//   },
//   '998': {
//     Reason: 'Order confirmation failure',
//     RTO: 'N/A',
//     USED_BY: 'SNP',
//     'Cause of cancellation & hence cost attributed to?': 'N/A',
//     'Applicable for part cancel?': 'N/A',
//   },
//   '997': {
//     Reason: 'Order confirmation failure',
//     RTO: 'N/A',
//     USED_BY: 'LSP',
//     'Cause of cancellation & hence cost attributed to?': 'N/A',
//     'Applicable for part cancel?': 'N/A',
//   },
//   '996': {
//     Reason: 'Order confirmation / completion failure',
//     RTO: 'N/A',
//     USED_BY: 'LBNP',
//     'Cause of cancellation & hence cost attributed to?': 'N/A',
//     'Applicable for part cancel?': 'N/A',
//   },
// }
export const reasonCodes = {
  '002': {
    Reason: 'One or more items in the order not available',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      'SNP accepted order that includes items not available, probably due to incorrect inventory information at their end',
    'States where applicable': 'Pending',
    'Applicable for part cancel?': 'Yes',
    'Settlement suggestions to be incorporated':
      "1. if buyer isn't interested in part-fill for the order, BNP can cancel the order as per flow defined here; \n2. settlement between BNP & SNP is basis the last updated quote for the order;",
  },
  '021': {
    Reason: 'Store not responsive',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      'SNP accepted order as auto-acceptance enabled for the store; however, the store is not accepting the order or is non-responsive',
    'States where applicable': 'Pending',
    'Applicable for part cancel?': 'No',
    'Settlement suggestions to be incorporated':
      'Settlement between BNP & SNP is basis the last updated quote for the order',
  },
  '022': {
    Reason: 'Technical issue in merchant device',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      "SNP accepted order as auto-acceptance enabled for the store; however, due to technical issue with merchant device at the store, order isn't getting relayed to the store",
    'States where applicable': 'Pending',
  },
  '023': {
    Reason: 'Order received during non-operational hours',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    Comment:
      'SNP receives order when store is closed, either temporarily or beyond normal operating hours',
    'States where applicable': 'Pending',
  },
  '024': {
    Reason: 'Order received during store rush',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      'SNP receives order during store rush, i.e. kitchen full or manpower shortage',
    'States where applicable': 'Pending',
  },
  '051': {
    Reason: 'Store is not accepting order',
    USED_BY: 'BNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      'BNP cancels the order in case the order is in created state for too long and is not getting accepted at the provider level',
    'States where applicable': 'Pending',
  },
  '011': {
    Reason: "Retail buyer not found / can't be contacted",
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    Comment: 'Use for offline logistics',
    'States where applicable': 'At-delivery (P2P); Out-for-delivery (P2H2P)',
  },
  '013': {
    Reason: "Retail buyer can't / doesn't want to accept delivery",
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    Comment: 'Use for offline logistics',
    'States where applicable': 'At-delivery (P2P); Out-for-delivery (P2H2P)',
  },
  '014': {
    Reason: 'Delivery address incorrect or not found',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    Comment: 'Use for offline logistics',
    'States where applicable': 'At-delivery (P2P); Out-for-delivery (P2H2P)',
  },
  '016': {
    Reason: 'Force majeure (accident / strike / law & order situation, etc)',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment: 'Use for offline logistics',
    'States where applicable':
      'Order-picked-up (P2P); Order-picked-up, In-transit, At-destination-hub (P2H2P);',
  },
  '018': {
    Reason: 'Order not serviceable',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    Comment:
      'Order not serviceable due to logistics issue, e.g. delivery location not serviceable, lost order; use for offline logistics',
    'States where applicable': 'At-destination-hub, Out-for-delivery (P2H2P);',
  },
  '052': {
    Reason: 'Order / fulfillment not received as per O2D TAT',
    USED_BY: 'BNP',
    'Cause of cancellation & hence cost attributed to?': 'SNP',
    'States where applicable':
      'Order-picked-up, At-delivery (P2P); Order-picked-up, In-transit, At-destination-hub, Out-for-delivery, Delivery-failed (P2H2P);',
  },
  '053': {
    Reason: 'Buyer wants to modify address / other order details',
    USED_BY: 'BNP',
    'Cause of cancellation & hence cost attributed to?': 'BNP',
    'States where applicable': 'any state prior to Order-delivered;',
  },
  '998': {
    Reason: 'Order confirmation failure',
    USED_BY: 'SNP',
    'Cause of cancellation & hence cost attributed to?': 'N/A',
    'States where applicable': 'Pending',
    'Applicable for part cancel?': 'N/A',
  },
  '999': {
    Reason: 'Order confirmation failure',
    USED_BY: 'BNP',
    'Cause of cancellation & hence cost attributed to?': 'N/A',
    'States where applicable': 'Pending',
  },
};

export const return_request_reasonCodes =['001', '002', '003', '004', '005'];
export const partcancel_return_reasonCodes =['002','012'];
export const return_rejected_request_reasonCodes =['001', '002', '003', '004', '005','007','008'];
export const condition_id=["001", "002", "003"] // "001" (proper working condition without damages), "002" (proper working condition with damages), "003" (not working);