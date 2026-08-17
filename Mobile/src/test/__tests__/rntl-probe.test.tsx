import { render, screen } from '@testing-library/react-native';
import { Text, View } from 'react-native';

describe('环境自检', () => {
  it('await render 后 screen 正常工作', async () => {
    await render(
      <View testID="probe">
        <Text>hello</Text>
      </View>,
    );
    expect(screen.getByTestId('probe')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });
});
