export type Page = 'dashboard' | 'appointments' | 'customers' | 'staff' | 'services' | 'analytics';
export type Appointment = { id: number; customer: string; initials: string; service: string; staff: string; time: string; duration: string; price: number; status: 'Confirmed' | 'In progress' | 'Completed' };
export const appointments: Appointment[] = [
  { id: 1, customer: 'Hamza Ahmed', initials: 'HA', service: 'Signature haircut & beard', staff: 'Ali Raza', time: '10:00 AM', duration: '45 min', price: 2500, status: 'Completed' },
  { id: 2, customer: 'Ayesha Khan', initials: 'AK', service: 'Hair colour & styling', staff: 'Sana Malik', time: '11:00 AM', duration: '90 min', price: 8500, status: 'In progress' },
  { id: 3, customer: 'Usman Tariq', initials: 'UT', service: 'Haircut & wash', staff: 'Bilal Hassan', time: '12:30 PM', duration: '30 min', price: 1800, status: 'Confirmed' },
  { id: 4, customer: 'Fatima Noor', initials: 'FN', service: 'Facial & skin care', staff: 'Sana Malik', time: '02:00 PM', duration: '60 min', price: 4500, status: 'Confirmed' },
  { id: 5, customer: 'Zain Shah', initials: 'ZS', service: 'Beard trim & shaping', staff: 'Ali Raza', time: '03:30 PM', duration: '30 min', price: 1200, status: 'Confirmed' },
];
export const formatPKR = (value: number) => `PKR ${value.toLocaleString('en-PK')}`;
